import {
  usagePaymentAgreement,
  usageTotals,
  settleUsagePayment,
} from "./product-usage-billing";
import type { TemplStaffEnv } from "./templ-staff";
import { getAddress, isAddress, toHex } from "viem";
import { isWorkspaceFlagKey } from "@templ/chat/workspace-flags";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
import {
  PRODUCT_OFFER_VERSION,
  PRODUCT_TOP_UP,
  PRODUCT_USAGE_PAYMENT_RECIPIENT,
} from "@templ/chat/plans";
import { formatUsdCents } from "@templ/chat/resolution-copy";
import { productTopUp, topUpBonusCents } from "@templ/chat/resolution-pricing";
import { pilotUpfrontRequestCents } from "@templ/chat/pilot-pricing";
import {
  getProductPaymentAsset,
  PRODUCT_RAILS,
  productPaymentRecipient,
  readProductPaymentRecipients,
  productPaymentAmountRaw,
  productTransferPaymentId,
  productSolanaPaymentMemo,
  type ProductPaymentRecipients,
  type ProductPaymentRecipient,
  type ProductPaymentNetwork,
  type ProductRailId,
  type ProductTopUpPreview,
  type ProductPaymentIntent,
  type ProductPaymentReceipt,
  type ProductPaymentConfirmation,
} from "@templ/chat/product-payment";
import {
  prepareSolanaProductTransfer,
  verifySolanaProductPayment,
  readSolanaProductTransfer,
  isSolanaPaymentSignature,
} from "./product-billing-solana";
import type { SolanaRpcEnv } from "./solana";
import type { StripeStoreEnv } from "./stripe-store";
import { isSolanaAddress } from "@templ/chat/solana";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { authorizationEndpoints, type ChainRpcEnv } from "./chain-rpc";
import { RPC_BUDGET, type RpcBudgetEnv } from "./rpc-budget";
import {
  block,
  normalizeReceipt,
  paymentReceiptTime,
  paymentRpc,
  rpcQuantity,
  type PaymentFetcher,
  type PaymentReceipt,
} from "./chain-payment-rpc";
import { HttpError, type Env } from "./common";
import { creditPrepaid, readPrepaidAccount } from "./product-prepaid";
import {
  activateVerifiedStandardPeriod,
  standardPlanView,
  standardPrepaidTerms,
  payStandardDebtFromCredit,
} from "./product-standard-plan";
import { markWorkspaceStep } from "./funnel-metrics";
import {
  productPaymentRpcEnv,
  type ProductPaymentRpcSecrets,
} from "./product-payment-rpc";
import {
  PRODUCT_STATE_KEY,
  TOP_UP_WHILE_SUSPENDED_KEY,
  creditTopUp,
  readProductState,
  standardPlanForState,
  recordProductEvent,
  type ProductStorage,
} from "./product-entitlements";
import {
  paymentLedgerCall,
  type PaymentReservation,
} from "./product-payment-ledger";
import {
  expectedPaymentFinalitySeconds,
  paymentScannerCall,
} from "./product-payment-scanner";
import {
  pilotUpfrontCreditCents,
  readProductOrderForms,
  reconcilePilotOrderFormActivations,
  processProductOrderForms,
  activeProductOrderForm as activeStandardAgreement,
} from "./product-order-forms";

export type ProductBillingEnv = WorkspaceFlagEnv &
  ProductPaymentRpcSecrets &
  Partial<StripeStoreEnv> &
  Partial<ChainRpcEnv> &
  Pick<RpcBudgetEnv, typeof RPC_BUDGET> &
  Partial<
    Pick<SolanaRpcEnv, "SOLANA_AUTH_RPC_URL" | "SOLANA_CONFIRMATION_RPC_URL">
  > &
  Partial<Pick<Env, "PRODUCT_PAYMENT_LEDGER" | "PRODUCT_PAYMENT_SCANNERS">> & {
    PRODUCT_PAYMENTS_ENABLED?: string;
    PRODUCT_RESOLUTION_BILLING_ENABLED?: string;
    PRODUCT_PAYMENT_RECIPIENTS?: string;
  };
export type ProductPaymentRpc = typeof paymentRpc;
export function createProductPaymentProofCache(
  fetcher: PaymentFetcher,
): ProductPaymentRpc {
  const reads = new Map<string, Promise<unknown>>();
  return (env, url, method, params) => {
    const key = JSON.stringify([url, method, params]);
    let read = reads.get(key);
    if (!read) {
      read = paymentRpc(env, url, method, params, fetcher);
      reads.set(key, read);
    }
    return read;
  };
}
export type StoredProductPaymentIntent = ProductPaymentIntent & {
  principalId: ChatPrincipalId;
  receipt?: ProductPaymentReceipt;
  receipts?: ProductPaymentReceipt[];
};
const INTENTS = "product-payment-intents-v1",
  INTENT_PREFIX = "product-payment-intent-v1:",
  HASH = /^0x[a-fA-F0-9]{64}$/;
export const PRODUCT_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const unavailable = () =>
  new HttpError(
    503,
    "Payments are unavailable.",
    undefined,
    "product-checkout-unavailable",
  );
export function requireProductPaymentRail(
  env: ProductBillingEnv,
  rail: unknown,
  storage?: undefined,
): void;
export function requireProductPaymentRail(
  env: ProductBillingEnv,
  rail: unknown,
  storage: Pick<ProductStorage, "get">,
): Promise<void>;
export function requireProductPaymentRail(
  env: ProductBillingEnv,
  rail: unknown,
  storage?: Pick<ProductStorage, "get">,
): void | Promise<void> {
  const key = `pay.${String(rail)}`;
  if (
    typeof rail !== "string" ||
    !Object.hasOwn(PRODUCT_RAILS, rail) ||
    !isWorkspaceFlagKey(key)
  )
    throw unavailable();
  if (storage)
    return featureOn(env, storage, key).then((on) => {
      if (!on) throw unavailable();
    });
  if (!featureOn(env, undefined, key)) throw unavailable();
}
export async function productPaymentRequest(
  storage: ProductStorage,
  id: string,
): Promise<StoredProductPaymentIntent | undefined> {
  return storage.get(`${INTENT_PREFIX}${id}`);
}
async function readIntents(
  storage: ProductStorage,
): Promise<StoredProductPaymentIntent[]> {
  const ids = (await storage.get<string[]>(INTENTS)) ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 512 ||
    ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
  )
    throw unavailable();
  return Promise.all(
    ids.map(async (id) => {
      const row = await productPaymentRequest(storage, id);
      if (!row || row.id !== id) throw unavailable();
      return row;
    }),
  );
}
export function publicPaymentIntent(
  intent: StoredProductPaymentIntent,
): ProductPaymentIntent {
  const { principalId: _, receipt: __, receipts: ___, ...view } = intent;
  return view;
}
export async function productPaymentRequests(
  storage: ProductStorage,
  nowMs = Date.now(),
) {
  return (await readIntents(storage))
    .filter((row) => row.offerVersion === PRODUCT_OFFER_VERSION)
    .map((row) =>
      publicPaymentIntent(
        Date.parse(row.expiresAt) <= nowMs &&
          ["open", "seen"].includes(row.status)
          ? { ...row, status: "expired" }
          : row,
      ),
    )
    .reverse();
}
export function paymentRecipients(
  env: ProductBillingEnv,
): ProductPaymentRecipients {
  try {
    return readProductPaymentRecipients(
      JSON.parse(env.PRODUCT_PAYMENT_RECIPIENTS ?? "{}"),
    );
  } catch {
    console.error("TEMPL_PRODUCT_RECIPIENTS_INVALID");
    return {};
  }
}
function recipient(
  env: ProductBillingEnv,
  id: unknown,
): ProductPaymentRecipient {
  if (typeof id !== "string" || !Object.hasOwn(PRODUCT_RAILS, id))
    throw new HttpError(400, "Choose a payment network and token.");
  const row = productPaymentRecipient(
    paymentRecipients(env),
    id as ProductRailId,
  );
  if (!row) throw unavailable();
  return row;
}
export async function previewTopUp(
  storage: ProductStorage,
  usdCents: number,
  nowMs: number,
  env: TemplStaffEnv = {},
): Promise<ProductTopUpPreview> {
  const state = await readProductState(storage, nowMs, env),
    bonusCents = topUpBonusCents(usdCents, state.balanceCents);
  return {
    usdCents,
    bonusCents,
    balanceBeforeCents: state.balanceCents,
    balanceAfterCents: state.balanceCents + usdCents + bonusCents,
    calculatedAt: new Date(nowMs).toISOString(),
  };
}
export type WalletOwner = (
  network: ProductPaymentNetwork,
  address: string,
) => Promise<ChatPrincipalId | null>;
export async function prepareProductPayment(
  storage: ProductStorage,
  input: {
    env: ProductBillingEnv;
    body: Record<string, unknown>;
    principalId: ChatPrincipalId;
    walletOwner: WalletOwner;
    room: string;
    nowMs: number;
    orderForm?: {
      orderFormId: string;
      orderFormRevision?: number;
      expiresAt?: unknown;
    };
    orderFormId?: string;
    orderFormRevision?: number;
    expiresAt?: number;
    fetcher?: PaymentFetcher;
    reserveRequest?: (
      intent: ProductPaymentIntent,
      principalId: ChatPrincipalId,
    ) => Promise<PaymentReservation | null>;
    registerScanner?: (
      intent: ProductPaymentIntent,
      principalId: ChatPrincipalId,
    ) => Promise<void>;
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
  if (input.body.settlement !== undefined)
    throw new HttpError(
      400,
      "The service selects how this payment is recorded.",
    );
  const standardPurpose =
    input.body.purpose === "standard-period"
      ? "period"
      : input.body.purpose === "standard-credit"
        ? "credit"
        : null;
  if (input.body.purpose !== undefined && !standardPurpose)
    throw new HttpError(400, "Choose a monthly payment or prepaid credit.");
  let standard;
  if (standardPurpose) {
    const state = await readProductState(storage, input.nowMs, input.env);
    if (
      !standardPlanForState(state) ||
      (await activeStandardAgreement(storage, input.nowMs))
    )
      throw new HttpError(409, "Keep this workspace's existing agreement.");
    const plan = await standardPlanView(storage, input.nowMs);
    if (input.body.expectedPeriod !== (plan.period?.id ?? null))
      throw new HttpError(
        409,
        "Read the current monthly period before paying.",
      );
    if (
      standardPurpose === "period" &&
      plan.period &&
      plan.period.endsAt > input.nowMs
    )
      throw new HttpError(409, "This monthly period has not ended.");
    standard = standardPrepaidTerms(standardPurpose, plan.period?.id ?? null);
  }
  const usageAgreement = await usagePaymentAgreement(
    storage,
    input.nowMs,
    input.env,
  );
  if (standard && (usageAgreement || input.orderForm || input.orderFormId))
    throw new HttpError(409, "Keep this workspace's existing agreement.");
  if (input.orderForm) {
    input.orderFormId = input.orderForm.orderFormId;
    input.orderFormRevision = input.orderForm.orderFormRevision;
    if (input.orderForm.expiresAt !== undefined) {
      input.expiresAt =
        typeof input.orderForm.expiresAt === "string"
          ? Date.parse(input.orderForm.expiresAt)
          : Number(input.orderForm.expiresAt);
    }
  }
  if (
    !input.orderForm &&
    (input.body.orderFormId !== undefined ||
      input.body.orderFormRevision !== undefined)
  )
    throw new HttpError(403, "Templ must create this payment request.");
  if (input.orderFormId) {
    const record = await readProductOrderForms(storage);
    const form = [...record.history]
      .reverse()
      .find((item) => item.id === input.orderFormId);
    if (form?.pilot) {
      if (!(await featureOn(input.env, storage, "pilotOrderForms")))
        throw new HttpError(409, "Pilot order forms are unavailable.");
      if (
        form.workspace !== input.room ||
        form.endsAt <= input.nowMs ||
        record.ended[form.id] !== undefined ||
        input.orderFormRevision !== form.revision
      )
        throw new HttpError(409, "Read the current pilot form and try again.");
      const evidence = await pilotUpfrontCreditCents(storage, form);
      const requiredCents = pilotUpfrontRequestCents(
        form.pilot.upfrontCents,
        evidence.paidCents,
      );
      if (requiredCents === 0 || input.body.usdCents !== requiredCents)
        throw new HttpError(400, "Use the upfront amount on this pilot form.");
    }
  }
  await requireProductPaymentRail(input.env, input.body.rail, storage);
  const config = recipient(input.env, input.body.rail),
    rail = input.body.rail as ProductRailId,
    usdCents = input.body.usdCents;
  if (standard && !["ethereum-usdc", "base-usdc", "bnb-usdc", "solana-usdc"].includes(rail))
    throw new HttpError(400, "Choose USDC on Ethereum, Base, BNB Chain or Solana.");
  if (
    usageAgreement &&
    (config.kind !== "evm" ||
      ![1, 8453].includes(Number(config.chain)) ||
      config.recipient.toLowerCase() !==
        PRODUCT_USAGE_PAYMENT_RECIPIENT.toLowerCase())
  )
    throw new HttpError(
      503,
      "This payment method is unavailable for usage billing.",
    );
  if (
    typeof usdCents !== "number" ||
    (standard
      ? !Number.isSafeInteger(usdCents) ||
        usdCents <= 0 ||
        usdCents > PRODUCT_TOP_UP.maxUsdCents ||
        (standard.purpose === "period" &&
          usdCents !== standard.workspaceMonthlyCents)
      : usageAgreement
        ? !Number.isSafeInteger(usdCents) ||
          usdCents <= 0 ||
          usdCents > usageAgreement.terms.debtLimitCents
        : input.orderFormId
          ? !Number.isSafeInteger(usdCents) ||
            usdCents <= 0 ||
            usdCents > 25_000_000 ||
            usdCents % 100 !== 0
          : !productTopUp(usdCents))
  )
    throw new HttpError(
      400,
      standard
        ? "Use the monthly price or a positive prepaid credit amount."
        : usageAgreement
          ? "Enter a payment from $0.01 to $1,000."
          : input.orderFormId
            ? "Choose whole dollars up to $250,000."
            : `Choose whole dollars from ${formatUsdCents(PRODUCT_TOP_UP.minUsdCents)} to ${formatUsdCents(PRODUCT_TOP_UP.maxUsdCents)}.`,
    );
  if (
    ["item", "plan", "units", "period", "safePayer"].some(
      (field) => input.body[field] !== undefined,
    )
  )
    throw new HttpError(400, "Enter a payment amount and payer.");
  const payer = input.body.payer;
  if (
    typeof payer !== "string" ||
    (config.kind === "solana" ? !isSolanaAddress(payer) : !isAddress(payer))
  )
    throw new HttpError(403, "Use a wallet you verified for this account.");
  const normalized = config.kind === "evm" ? getAddress(payer) : payer;
  if (
    config.kind === "solana"
      ? normalized === config.recipient
      : normalized.toLowerCase() === config.recipient.toLowerCase()
  )
    throw new HttpError(400, "Choose a different paying wallet.");
  const payerOwner = await input.walletOwner(config.chain, normalized);
  if (!payerOwner || (!input.orderForm && payerOwner !== input.principalId))
    throw new HttpError(403, "Use a wallet you verified for this account.");
  const requestPrincipal = input.orderForm ? payerOwner : input.principalId;
  const saved = await readIntents(storage),
    active = saved.filter(
      (row) =>
        ["open", "seen"].includes(row.status) &&
        Date.parse(row.expiresAt) > input.nowMs,
    ),
    replacing = active.find(
      (row) =>
        row.rail === rail &&
        (config.kind === "solana"
          ? row.payer === normalized
          : row.payer.toLowerCase() === normalized.toLowerCase()) &&
        row.principalId === requestPrincipal,
    );
  if (active.length - (replacing ? 1 : 0) >= 4)
    throw new HttpError(409, "You have 4 open payment requests.");
  if (saved.length >= 512)
    throw new HttpError(409, "Billing history needs an operator review.");
  const id = crypto.randomUUID(),
    asset = getProductPaymentAsset(config.chain, config.symbol)!;
  const preview = standard
    ? {
        usdCents,
        bonusCents: 0,
        balanceBeforeCents: 0,
        balanceAfterCents: usdCents,
        calculatedAt: new Date(input.nowMs).toISOString(),
      }
    : await previewTopUp(storage, usdCents, input.nowMs, input.env);
  if (standard) {
    const account = await readPrepaidAccount(storage);
    const available = BigInt(account.cashAvailableUsdNanos) / 10_000_000n;
    if (available > BigInt(Number.MAX_SAFE_INTEGER - usdCents))
      throw unavailable();
    preview.balanceBeforeCents = Number(available);
    preview.balanceAfterCents = Number(available) + usdCents;
  } else if (usageAgreement) {
    const usage = await usageTotals(storage);
    preview.balanceBeforeCents = usage.creditCents - usage.dueCents;
    preview.balanceAfterCents = preview.balanceBeforeCents + usdCents;
    preview.bonusCents = 0;
  } else if (input.orderFormId) {
    preview.bonusCents = 0;
    preview.balanceAfterCents = preview.balanceBeforeCents + usdCents;
  }
  const expiresAt =
    input.expiresAt ?? input.nowMs + (input.orderFormId ? 30 : 1) * 86_400_000;
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= input.nowMs ||
    expiresAt > input.nowMs + (input.orderFormId ? 30 : 1) * 86_400_000
  )
    throw new HttpError(400, "Choose a valid payment expiry.");
  const common = {
    id,
    room: input.room,
    workspace: input.room,
    offerVersion: PRODUCT_OFFER_VERSION as typeof PRODUCT_OFFER_VERSION,
    rail,
    network: config.chain,
    token: config.symbol,
    recipient: config.recipient,
    payer: normalized,
    usdCents,
    amountRaw: productPaymentAmountRaw(usdCents, config.decimals),
    createdAt: new Date(input.nowMs).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    status: "open" as const,
    asset: {
      address: asset.address,
      symbol: asset.symbol,
      label: asset.label,
      decimals: asset.decimals,
    },
    preview,
    expectedFinalitySeconds: expectedPaymentFinalitySeconds(config.chain),
    ...(standard ? { settlement: "standard-prepaid" as const, standard } : {}),
    ...(usageAgreement
      ? {
          settlement: "manual-usage" as const,
          orderFormId: usageAgreement.id,
          orderFormRevision: usageAgreement.revision,
        }
      : {}),
    ...(input.orderFormId
      ? {
          orderFormId: input.orderFormId,
          ...(input.orderFormRevision
            ? { orderFormRevision: input.orderFormRevision }
            : {}),
          creditedCents: 0,
        }
      : {}),
  };
  const intent: StoredProductPaymentIntent =
    config.kind === "evm"
      ? {
          ...common,
          kind: "evm",
          chainId: config.chain as Exclude<ProductPaymentNetwork, "solana">,
          payer: getAddress(normalized),
          principalId: requestPrincipal,
        }
      : {
          ...common,
          kind: "solana",
          chainId: "solana",
          principalId: requestPrincipal,
          memo: productSolanaPaymentMemo(id),
          ...(await prepareSolanaProductTransfer(
            input.env as SolanaRpcEnv,
            config,
            normalized,
            common.amountRaw,
            input.fetcher,
          )),
        };
  const reservation = {
    payer: intent.payer,
    rail,
    workspace: intent.workspace,
    principalId: requestPrincipal,
    requestId: id,
    expiresAt: intent.expiresAt,
  };
  const replaced = input.reserveRequest
    ? await input.reserveRequest(intent, requestPrincipal)
    : ((await paymentLedgerCall(input.env, "reserve", reservation))
        .replaced as PaymentReservation | null);
  input.reservationCreated?.(reservation, replaced);
  if (replacing)
    await storage.put(`${INTENT_PREFIX}${replacing.id}`, {
      ...replacing,
      status: "replaced",
    });
  await storage.put(`${INTENT_PREFIX}${id}`, intent);
  await storage.put(INTENTS, [...saved.map((row) => row.id), id]);
  if (standard) {
    // A captured Standard intent starts no address watcher or provider request.
    if (replaced)
      await paymentScannerCall(input.env, config.chain, "close", {
        requestId: replaced.requestId,
        status: "replaced",
      }).catch(() => undefined);
  } else if (input.deferRegistration) {
    await storage.put(`${PRODUCT_PAYMENT_REGISTRATION_PREFIX}${id}`, {
      intent: publicPaymentIntent(intent),
      principalId: requestPrincipal,
      replaced,
    });
    input.deferRegistration(
      publicPaymentIntent(intent),
      requestPrincipal,
      replaced,
    );
  } else {
    if (replaced)
      await paymentScannerCall(input.env, config.chain, "close", {
        requestId: replaced.requestId,
        status: "replaced",
      }).catch(() => undefined);
    if (input.registerScanner)
      await input.registerScanner(
        publicPaymentIntent(intent),
        requestPrincipal,
      );
    else
      await paymentScannerCall(input.env, config.chain, "register", {
        intent: publicPaymentIntent(intent),
      });
  }
  await recordProductEvent(storage, `checkout:${id}`, {
    action: "checkout.prepared",
    at: input.nowMs,
    cents: usdCents,
  });
  if (!saved.length)
    await markWorkspaceStep(storage, "checkout_started", input.nowMs);
  return { intent: publicPaymentIntent(intent) };
}
export type VerifiedProductTransfer = {
  paidAt: number;
  txHash: string;
  amountRaw: string;
  usdCents: number;
  logIndex?: number;
  instructionIndex?: number;
  confirmation?: ProductPaymentConfirmation;
};
export function matchEvmProductTransfer(
  receipt: PaymentReceipt,
  intent: Extract<ProductPaymentIntent, { kind: "evm" }>,
): Omit<VerifiedProductTransfer, "paidAt"> {
  if (receipt.status !== "0x1")
    throw new HttpError(
      422,
      "This transaction does not match the payment request.",
    );
  const transfers = receipt.logs.filter(
    (log) => log.topics[0] === PRODUCT_TRANSFER_TOPIC,
  );
  if (transfers.length !== 1)
    throw new HttpError(
      422,
      "This transaction does not match the payment request.",
    );
  const log = transfers[0];
  const raw = /^0x[0-9a-f]{64}$/.test(log.data) ? BigInt(log.data) : 0n,
    centUnits = 10n ** BigInt(intent.asset.decimals - 2),
    actualCents = raw / centUnits,
    inbound =
      log.address === intent.asset.address.toLowerCase() &&
      log.topics.length === 3 &&
      `0x${log.topics[2].slice(-40)}` === intent.recipient.toLowerCase() &&
      raw > 0n &&
      raw % centUnits === 0n &&
      actualCents <= BigInt(PRODUCT_TOP_UP.maxUsdCents);
  const mismatch = () =>
    Object.assign(
      new HttpError(
        422,
        "This transaction does not match the payment request.",
      ),
      {
        paymentIndex: Number(rpcQuantity(log.logIndex)),
        creditEligible: inbound,
        actualCents: inbound ? Number(actualCents) : null,
      },
    );
  if (
    log.address !== intent.asset.address.toLowerCase() ||
    log.topics.length !== 3 ||
    !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[1]) ||
    !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[2]) ||
    `0x${log.topics[1].slice(-40)}` !== intent.payer.toLowerCase() ||
    `0x${log.topics[2].slice(-40)}` !== intent.recipient.toLowerCase() ||
    !/^0x[0-9a-f]{64}$/.test(log.data)
  )
    throw mismatch();
  const amount = BigInt(log.data),
    units = 10n ** BigInt(intent.asset.decimals - 2),
    cents = amount / units,
    index = Number(rpcQuantity(log.logIndex));
  if (
    amount <= 0n ||
    amount % units !== 0n ||
    cents > 25_000_000n ||
    (!intent.orderFormId && amount.toString() !== intent.amountRaw) ||
    !Number.isSafeInteger(index)
  )
    throw mismatch();
  return {
    txHash: receipt.transactionHash,
    amountRaw: amount.toString(),
    usdCents: Number(cents),
    logIndex: index,
  };
}
export async function readProductPayment(
  env: ProductBillingEnv,
  intent: ProductPaymentIntent,
  tx: string,
  input: {
    nowMs: number;
    fetcher?: PaymentFetcher;
    storage?: Pick<ProductStorage, "get">;
  },
): Promise<
  (Omit<VerifiedProductTransfer, "paidAt"> & { paidAt?: number }) | null
> {
  env = productPaymentRpcEnv(env);
  if (input.storage)
    await requireProductPaymentRail(env, intent.rail, input.storage);
  else requireProductPaymentRail(env, intent.rail);
  if (intent.kind === "solana")
    return readSolanaProductTransfer(
      env as SolanaRpcEnv,
      intent,
      tx,
      input,
    ).then((row) => (row ? { ...row, txHash: tx } : null));
  if (!HASH.test(tx)) throw new HttpError(400, "Enter the transaction hash.");
  const receipt = await paymentRpc(
      env,
      authorizationEndpoints(env as ChainRpcEnv, intent.chainId)[0],
      "eth_getTransactionReceipt",
      [tx],
      input.fetcher,
    ),
    value = normalizeReceipt(receipt);
  if (!value) return null;
  if (value.transactionHash !== tx.toLowerCase()) throw unavailable();
  return {
    ...matchEvmProductTransfer(value, intent),
    paidAt: paymentReceiptTime(receipt),
    confirmation: {
      kind: "evm",
      transactionBlock: rpcQuantity(value.blockNumber).toString(),
      finalizedBlock: null,
      remainingBlocks: null,
      checkedAt: new Date(input.nowMs).toISOString(),
    },
  };
}
export async function verifyProductPayment(
  env: ProductBillingEnv,
  intent: ProductPaymentIntent,
  tx: string,
  input: {
    nowMs: number;
    fetcher?: PaymentFetcher;
    rpc?: ProductPaymentRpc;
    storage?: Pick<ProductStorage, "get">;
    observeConfirmation?: (value: ProductPaymentConfirmation) => void | Promise<void>;
  },
): Promise<VerifiedProductTransfer> {
  env = productPaymentRpcEnv(env);
  if (input.storage)
    await requireProductPaymentRail(env, intent.rail, input.storage);
  else requireProductPaymentRail(env, intent.rail);
  const config = recipient(env, intent.rail);
  if (
    intent.offerVersion !== PRODUCT_OFFER_VERSION ||
    intent.network !== config.chain ||
    intent.recipient !== config.recipient ||
    intent.asset.address.toLowerCase() !== config.asset.toLowerCase() ||
    intent.asset.decimals !== config.decimals ||
    intent.amountRaw !==
      productPaymentAmountRaw(intent.usdCents, config.decimals)
  )
    throw unavailable();
  if (intent.kind === "solana")
    return verifySolanaProductPayment(
      env as SolanaRpcEnv,
      config,
      intent,
      tx,
      input,
    );
  if (!HASH.test(tx)) throw new HttpError(400, "Enter the transaction hash.");
  const urls = authorizationEndpoints(env as ChainRpcEnv, intent.chainId);
  const facts = await Promise.all(
    urls.map(async (url) => {
      const [receipt, head, chain] = await Promise.all([
        (input.rpc ?? paymentRpc)(
          env,
          url,
          "eth_getTransactionReceipt",
          [tx],
          input.fetcher,
        ).then(normalizeReceipt),
        (input.rpc ?? paymentRpc)(
          env,
          url,
          "eth_getBlockByNumber",
          ["finalized", false],
          input.fetcher,
        ).then(block),
        (input.rpc ?? paymentRpc)(env, url, "eth_chainId", [], input.fetcher),
      ]);
      return { receipt, head, chain };
    }),
  );
  if (facts.some((row) => rpcQuantity(row.chain) !== BigInt(intent.chainId)))
    throw new HttpError(503, "Payment network could not be verified.");
  const [a, b] = facts;
  if ((a.receipt === null) !== (b.receipt === null))
    throw new HttpError(503, "Independent payment reads disagree.");
  if (!a.receipt || !b.receipt)
    throw new HttpError(
      409,
      "The transfer is still confirming.",
      undefined,
      "product-payment-receipt-missing",
    );
  if (
    JSON.stringify(a.receipt) !== JSON.stringify(b.receipt) ||
    a.receipt.transactionHash !== tx.toLowerCase()
  )
    throw new HttpError(503, "Independent payment reads disagree.");
  const number = rpcQuantity(a.receipt.blockNumber);
  const finalized = facts
    .map((row) => rpcQuantity(row.head.number))
    .reduce((minimum, value) => (value < minimum ? value : minimum));
  const confirmation: ProductPaymentConfirmation = {
    kind: "evm",
    transactionBlock: number.toString(),
    finalizedBlock: finalized.toString(),
    remainingBlocks: (number > finalized ? number - finalized : 0n).toString(),
    checkedAt: new Date(input.nowMs).toISOString(),
  };
  // Progress is not proof of credit. Do not publish a receipt for a different transfer.
  let matched = false;
  try {
    matchEvmProductTransfer(a.receipt, intent);
    matched = true;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 422) throw error;
  }
  if (matched) await input.observeConfirmation?.(confirmation);
  if (facts.some((row) => number > rpcQuantity(row.head.number)))
    throw new HttpError(409, "The transfer is still confirming.");
  const blocks = await Promise.all(
    urls.map((url) =>
      (input.rpc ?? paymentRpc)(
        env,
        url,
        "eth_getBlockByNumber",
        [toHex(number), false],
        input.fetcher,
      ).then(block),
    ),
  );
  if (
    blocks.some(
      (row) =>
        row.hash !== a.receipt!.blockHash || rpcQuantity(row.number) !== number,
    ) ||
    blocks[0].timestamp !== blocks[1].timestamp
  )
    throw new HttpError(503, "Independent payment reads disagree.");
  const paidAt = Number(rpcQuantity(blocks[0].timestamp)) * 1000;
  if (
    !Number.isSafeInteger(paidAt) ||
    paidAt < Date.parse(intent.createdAt) - 120_000 ||
    paidAt > input.nowMs
  )
    throw new HttpError(
      422,
      "This transaction does not match the payment request.",
    );
  return { ...matchEvmProductTransfer(a.receipt, intent), paidAt, confirmation };
}
export function paymentConfirmation(
  input: unknown,
  kind: ProductPaymentIntent["kind"],
  nowMs = Date.now(),
): ProductPaymentConfirmation {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "Payment confirmation is invalid.");
  const value = input as ProductPaymentConfirmation;
  const decimal = (field: unknown): field is string =>
    typeof field === "string" && /^(0|[1-9][0-9]{0,77})$/.test(field);
  const checkedAt =
    value && typeof value.checkedAt === "string"
      ? Date.parse(value.checkedAt)
      : NaN;
  if (
    value.kind !== kind ||
    !Number.isFinite(checkedAt) ||
    // Observation time is display metadata. Objects can have small clock skew.
    checkedAt > nowMs + 5_000 ||
    new Date(checkedAt).toISOString() !== value.checkedAt
  )
    throw new HttpError(400, "Payment confirmation is invalid.");
  if (value.kind === "solana") {
    if (
      Object.keys(value).sort().join(",") !==
        "checkedAt,commitment,kind,slot" ||
      !decimal(value.slot) ||
      !["confirmed", "finalized"].includes(value.commitment)
    )
      throw new HttpError(400, "Payment confirmation is invalid.");
  } else if (
    Object.keys(value).sort().join(",") !==
      "checkedAt,finalizedBlock,kind,remainingBlocks,transactionBlock" ||
    !decimal(value.transactionBlock) ||
    (value.finalizedBlock === null
      ? value.remainingBlocks !== null
      : !decimal(value.finalizedBlock) ||
        !decimal(value.remainingBlocks) ||
        BigInt(value.remainingBlocks) !==
          (BigInt(value.transactionBlock) > BigInt(value.finalizedBlock)
            ? BigInt(value.transactionBlock) - BigInt(value.finalizedBlock)
            : 0n))
  )
    throw new HttpError(400, "Payment confirmation is invalid.");
  return value;
}
export async function updateProductPaymentEvent(
  storage: ProductStorage,
  input: {
    requestId: string;
    status: ProductPaymentIntent["status"];
    tx?: string;
    clearSubmission?: boolean;
    verificationReviewRequired?: boolean;
    nextCheckAt?: number;
    checkAgainAt?: number;
    confirmation?: unknown;
  },
  nowMs = Date.now(),
) {
  const intent = await productPaymentRequest(storage, input.requestId);
  if (!intent) throw new HttpError(404, "Payment request not found.");
  if (intent.status === "credited" || intent.status === "replaced")
    return { intent: publicPaymentIntent(intent) };
  const confirmation = input.confirmation === undefined ? undefined :
    paymentConfirmation(input.confirmation, intent.kind, nowMs);
  intent.status =
    Date.parse(intent.expiresAt) <= nowMs ? "expired" : input.status;
  if (input.tx) {
    if (input.tx !== intent.submittedTx) delete intent.confirmation;
    intent.submittedTx = input.tx;
  }
  if (confirmation && intent.submittedTx) intent.confirmation = confirmation;
  if (input.clearSubmission && intent.status === "open") {
    delete intent.submittedTx;
    delete intent.nextCheckAt;
    delete intent.confirmation;
  }
  if (input.verificationReviewRequired === true) {
    intent.verificationReviewRequired = true;
    delete intent.nextCheckAt;
  }
  if (!intent.verificationReviewRequired && input.nextCheckAt !== undefined)
    intent.nextCheckAt = input.nextCheckAt;
  if (input.checkAgainAt !== undefined)
    intent.checkAgainAt = input.checkAgainAt;
  await storage.put(`${INTENT_PREFIX}${intent.id}`, intent);
  return { intent: publicPaymentIntent(intent) };
}
export type UnmatchedPayment = {
  settlement?: "manual-usage" | "standard-prepaid";
  creditEligible?: boolean;
  paymentId: string;
  chainId: ProductPaymentNetwork;
  txHash: string;
  usdCents: number;
  reason: string;
  at: number;
  status: "open" | "credited" | "returned";
  creditedCents?: number;
  answeredBy?: ChatPrincipalId;
};
export const UNMATCHED_PREFIX = "product-unmatched-v1:";
const UNMATCHED_MAX = 50,
  UNMATCHED_MESSAGE = "Templ will check this transfer.";
export const topUpPaymentId = (
  intent: Pick<ProductPaymentIntent, "chainId">,
  tx: string,
  index = 0,
) => productTransferPaymentId(intent.chainId, tx, index);
export async function recordUnmatched(
  storage: ProductStorage,
  row: UnmatchedPayment,
) {
  const key = `${UNMATCHED_PREFIX}${row.paymentId}`;
  if (await storage.get(key)) return;
  const count = (await storage.get<number>(`${UNMATCHED_PREFIX}count`)) ?? 0;
  if (count >= UNMATCHED_MAX)
    throw new HttpError(409, "Billing history needs an operator review.");
  await storage.put(key, row);
  await storage.put(`${UNMATCHED_PREFIX}count`, count + 1);
  console.warn(
    JSON.stringify({
      event: "TEMPL_PRODUCT_UNMATCHED_PAYMENT",
      reason: row.reason,
    }),
  );
}
/** Authorized work captured by the Room, performed after its storage transaction. */
export type ProductPaymentScannerWork = {
  action: "submit" | "check" | "blockhash";
  intent: ProductPaymentIntent;
  tx?: string;
};
export type ProductPaymentScannerResult = {
  action: ProductPaymentScannerWork["action"];
  requestId: string;
  tx?: string;
  value: Record<string, unknown>;
};
export type ProductPaymentScannerDeferral = {
  deferScanner?: (work: ProductPaymentScannerWork) => void;
  scannerResult?: ProductPaymentScannerResult;
};

export async function settleProductPayment(
  storage: ProductStorage & Pick<DurableObjectTransaction, "list">,
  input: {
    env: ProductBillingEnv;
    body: Record<string, unknown>;
    principalId: ChatPrincipalId;
    walletOwner: WalletOwner;
    room: string;
    nowMs: number;
    finalize?: boolean;
    verifyTransfer?: () => Promise<VerifiedProductTransfer>;
    fetcher?: PaymentFetcher;
    isCurrentRequest?: (intent: ProductPaymentIntent) => Promise<boolean>;
    claimPayment?: (paymentId: string) => Promise<ProductPaymentReceipt | null>;
    completePayment?: (
      paymentId: string,
      receipt: ProductPaymentReceipt,
    ) => Promise<void>;
    closeScanner?: (intent: ProductPaymentIntent) => Promise<void>;
    deferScanner?: ProductPaymentScannerDeferral["deferScanner"];
    scannerResult?: ProductPaymentScannerResult;
    deferCompletion?: (
      paymentId: string,
      receipt: ProductPaymentReceipt,
      intent: ProductPaymentIntent,
    ) => void;
  },
) {
  const id = input.body.requestId,
    submitted = input.body.tx;
  if (typeof id !== "string" || typeof submitted !== "string")
    throw new HttpError(400, "Choose a payment request and transaction.");
  const intent = await productPaymentRequest(storage, id);
  if (!intent || intent.room !== input.room)
    throw new HttpError(404, "Payment request not found.");
  const tx = intent.kind === "evm" ? submitted.toLowerCase() : submitted;
  if (intent.kind === "evm" ? !HASH.test(tx) : !isSolanaPaymentSignature(tx))
    throw new HttpError(
      400,
      intent.kind === "evm"
        ? "Enter the transaction hash."
        : "Enter the transaction signature.",
    );
  if (
    intent.receipts?.some((row) => row.txHash === tx) ||
    intent.receipt?.txHash === tx
  ) {
    const receipt =
      intent.receipts?.find((row) => row.txHash === tx) ?? intent.receipt!;
    input.deferCompletion?.(
      receipt.paymentId,
      receipt,
      publicPaymentIntent(intent),
    );
    return { receipt, intent: publicPaymentIntent(intent) };
  }
  if (
    !["open", "seen"].includes(intent.status) ||
    Date.parse(intent.expiresAt) <= input.nowMs
  )
    throw new HttpError(409, "This payment request has expired or closed.");
  if (intent.offerVersion !== PRODUCT_OFFER_VERSION) throw unavailable();
  await requireProductPaymentRail(input.env, intent.rail, storage);
  if (
    (await input.walletOwner(intent.network, intent.payer)) !==
    intent.principalId
  )
    throw new HttpError(
      403,
      "The paying wallet is not linked to this account.",
    );
  const current = input.isCurrentRequest
    ? await input.isCurrentRequest(intent)
    : (
        await paymentLedgerCall(input.env, "current", {
          payer: intent.payer,
          rail: intent.rail,
          requestId: intent.id,
          workspace: intent.workspace,
        })
      ).current === true;
  if (!current) throw new HttpError(409, "This payment request has closed.");
  if (!input.finalize && intent.verificationReviewRequired)
    throw new HttpError(
      409,
      "This transfer needs a payment review. Do not send it again.",
      undefined,
      "product-payment-review-required",
    );
  if (!input.finalize && input.deferScanner && !input.scannerResult) {
    // Commit the paid transfer hash before touching another object. The durable
    // handoff retries registration/submission if this response is interrupted.
    if (intent.submittedTx !== tx) delete intent.confirmation;
    intent.submittedTx = tx;
    await storage.put(`${INTENT_PREFIX}${id}`, intent);
    if (intent.settlement === "standard-prepaid")
      await storage.put(PRODUCT_PAYMENT_REGISTRATION_PREFIX + id, {
        intent: publicPaymentIntent(intent),
        principalId: intent.principalId,
        replaced: null,
      } satisfies PaymentRegistration);
    input.deferScanner({
      action: "submit",
      intent: publicPaymentIntent(intent),
      tx,
    });
    return { intent: publicPaymentIntent(intent) };
  }
  if (
    !input.finalize &&
    !input.scannerResult &&
    intent.settlement === "standard-prepaid"
  )
    await paymentScannerCall(input.env, intent.network, "register", {
      intent: publicPaymentIntent(intent),
    });
  intent.submittedTx = tx;
  await storage.put(`${INTENT_PREFIX}${id}`, intent);
  if (!input.finalize) {
    if (
      input.scannerResult &&
      (input.scannerResult.action !== "submit" ||
        input.scannerResult.requestId !== id ||
        input.scannerResult.tx !== tx)
    )
      throw new HttpError(409, "The payment request changed. Review it again.");
    const answer =
      input.scannerResult?.value ??
      (await paymentScannerCall(input.env, intent.network, "submit", {
        requestId: id,
        tx,
      }));
    if (answer.seen === true) {
      intent.status = "seen";
      intent.nextCheckAt = Number(answer.nextCheckAt);
      if (answer.confirmation !== undefined)
        intent.confirmation = paymentConfirmation(
          answer.confirmation,
          intent.kind,
          input.nowMs,
        );
      await storage.put(`${INTENT_PREFIX}${id}`, intent);
    }
    return { intent: publicPaymentIntent(intent) };
  }
  let verified: VerifiedProductTransfer;
  try {
    verified = input.verifyTransfer
      ? await input.verifyTransfer()
      : await verifyProductPayment(input.env, intent, tx, {
          nowMs: input.nowMs,
          fetcher: input.fetcher,
          storage,
        });
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 422) throw error;
    await recordUnmatched(storage, {
      paymentId: topUpPaymentId(
        intent,
        tx,
        Number.isSafeInteger(
          (error as HttpError & { paymentIndex?: number }).paymentIndex,
        )
          ? (error as HttpError & { paymentIndex: number }).paymentIndex
          : 0,
      ),
      chainId: intent.chainId,
      txHash: tx,
      usdCents:
        (error as HttpError & { actualCents?: number }).actualCents ??
        intent.usdCents,
      ...(intent.settlement ? { settlement: intent.settlement } : {}),
      creditEligible:
        (error as HttpError & { creditEligible?: boolean }).creditEligible ===
        true,
      reason: error.message,
      at: input.nowMs,
      status: "open",
    });
    intent.status = "open";
    intent.processedTransaction = { tx, outcome: "unmatched" };
    delete intent.submittedTx;
    delete intent.nextCheckAt;
    await storage.put(`${INTENT_PREFIX}${id}`, intent);
    return {
      unmatched: { txHash: tx, message: UNMATCHED_MESSAGE },
      intent: publicPaymentIntent(intent),
    };
  }
  if (verified.confirmation) intent.confirmation = verified.confirmation;
  const paymentId = productTransferPaymentId(
    intent.network,
    verified.txHash,
    verified.logIndex ?? verified.instructionIndex ?? 0,
  );
  if (
    intent.settlement === "standard-prepaid" &&
    (!intent.standard ||
      !["period", "credit"].includes(intent.standard.purpose) ||
      !["ethereum-usdc", "base-usdc", "bnb-usdc", "solana-usdc"].includes(intent.rail))
  )
    throw unavailable();
  await requireProductPaymentRail(input.env, intent.rail, storage);
  if (
    intent.settlement === "manual-usage" &&
    (intent.kind !== "evm" ||
      ![1, 8453].includes(intent.network as number) ||
      intent.recipient.toLowerCase() !==
        PRODUCT_USAGE_PAYMENT_RECIPIENT.toLowerCase())
  )
    throw unavailable();
  const claimed = input.claimPayment
    ? await input.claimPayment(paymentId)
    : ((
        await paymentLedgerCall(input.env, "claim", {
          paymentId,
          workspace: intent.workspace,
          payer: intent.payer,
          rail: intent.rail,
          requestId: intent.id,
        })
      ).receipt as ProductPaymentReceipt | null);
  if (claimed) {
    intent.status = "open";
    intent.processedTransaction = { tx, outcome: "credited" };
    delete intent.submittedTx;
    delete intent.nextCheckAt;
    await storage.put(`${INTENT_PREFIX}${id}`, intent);
    return { receipt: claimed, intent: publicPaymentIntent(intent) };
  }
  await requireProductPaymentRail(input.env, intent.rail, storage);
  if (
    intent.settlement === "manual-usage" &&
    (intent.kind !== "evm" ||
      ![1, 8453].includes(intent.network as number) ||
      intent.recipient.toLowerCase() !==
        PRODUCT_USAGE_PAYMENT_RECIPIENT.toLowerCase())
  )
    throw unavailable();
  let activatedPeriodId: string | null = null;
  const prepaidPayment =
    intent.settlement === "standard-prepaid"
      ? await creditPrepaid(storage, {
          receiptId: paymentId,
          amountUsdNanos: (BigInt(verified.usdCents) * 10_000_000n).toString(),
          at: input.nowMs,
        })
      : null;
  if (prepaidPayment && intent.standard?.purpose === "period") {
    try {
      activatedPeriodId = (
        await activateVerifiedStandardPeriod(storage, {
          paymentId,
          terms: intent.standard,
          at: input.nowMs,
        })
      ).id;
    } catch (error) {
      // A concurrent renewal never loses received funds or replaces the current month.
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
  }
  if (prepaidPayment) await payStandardDebtFromCredit(storage, input.nowMs);
  const manualPayment =
    intent.settlement === "manual-usage"
      ? await settleUsagePayment(storage, {
          id: `payment:${paymentId}`,
          paymentId,
          cents: verified.usdCents,
          at: input.nowMs,
        })
      : null;
  const prepaidAvailable = prepaidPayment
    ? BigInt((await readPrepaidAccount(storage)).cashAvailableUsdNanos) /
      10_000_000n
    : 0n;
  if (prepaidAvailable > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  const result = prepaidPayment
    ? {
        credited: prepaidPayment.credited,
        bonusCents: 0,
        suspended: false,
        state: { balanceCents: Number(prepaidAvailable) },
      }
    : manualPayment
      ? {
          credited: manualPayment.posted,
          bonusCents: 0,
          suspended: false,
          state: {
            balanceCents:
              manualPayment.totals.creditCents - manualPayment.totals.dueCents,
          },
        }
      : await creditTopUp(storage, {
          paymentId,
          usdCents: verified.usdCents,
          paidAt: verified.paidAt,
          nowMs: input.nowMs,
          orderForm: Boolean(intent.orderFormId),
          env: input.env,
        });
  const receipt: ProductPaymentReceipt = {
    ...(intent.settlement ? { settlement: intent.settlement } : {}),
    ...(intent.standard
      ? { standard: { ...intent.standard, activatedPeriodId } }
      : {}),
    paymentId,
    requestId: id,
    ...(intent.orderFormId ? { orderFormId: intent.orderFormId } : {}),
    ...(intent.orderFormRevision
      ? { orderFormRevision: intent.orderFormRevision }
      : {}),
    rail: intent.rail,
    txHash: verified.txHash,
    kind: intent.kind,
    network: intent.network,
    token: intent.token,
    asset: intent.asset,
    offerVersion: intent.offerVersion,
    usdCents: verified.usdCents,
    bonusCents: result.credited ? result.bonusCents : 0,
    amountRaw: verified.amountRaw,
    chainId: intent.chainId,
    recipient: intent.recipient,
    ...(verified.logIndex !== undefined
      ? { logIndex: verified.logIndex }
      : { instructionIndex: verified.instructionIndex }),
    paidAt: new Date(verified.paidAt).toISOString(),
    creditedAt: new Date(input.nowMs).toISOString(),
    payer: intent.payer,
    balanceAfterCents: result.state.balanceCents,
  };
  intent.receipts = [...(intent.receipts ?? []), receipt];
  intent.processedTransaction = { tx, outcome: "credited" };
  intent.receipt = receipt;
  intent.creditedCents = (intent.creditedCents ?? 0) + verified.usdCents;
  delete intent.verificationReviewRequired;
  intent.status =
    intent.settlement === "manual-usage" ||
    !intent.orderFormId ||
    intent.creditedCents >= intent.usdCents
      ? "credited"
      : "open";
  if (intent.status === "open") {
    delete intent.submittedTx;
    delete intent.nextCheckAt;
  }
  await storage.put(`${INTENT_PREFIX}${id}`, intent);
  if (
    intent.orderFormRevision &&
    (await reconcilePilotOrderFormActivations(
      storage as Parameters<typeof reconcilePilotOrderFormActivations>[0],
      input.nowMs,
      input.env,
    ))
  )
    await processProductOrderForms(
      storage as Parameters<typeof processProductOrderForms>[0],
      input.env,
      input.nowMs,
    );
  if (input.deferCompletion)
    input.deferCompletion(paymentId, receipt, publicPaymentIntent(intent));
  else if (input.completePayment)
    await input.completePayment(paymentId, receipt);
  else
    await paymentLedgerCall(input.env, "complete", {
      paymentId,
      workspace: intent.workspace,
      receipt,
    });
  if (intent.status === "credited" && !input.deferCompletion) {
    await paymentLedgerCall(input.env, "release", {
      payer: intent.payer,
      rail: intent.rail,
      requestId: id,
      workspace: intent.workspace,
    });
    if (input.closeScanner) await input.closeScanner(intent);
    else
      await paymentScannerCall(input.env, intent.network, "close", {
        requestId: id,
        status: "credited",
      });
  }
  if (result.credited && result.suspended) {
    await storage.put(TOP_UP_WHILE_SUSPENDED_KEY, { at: input.nowMs });
    await recordProductEvent(storage, `topup-while-suspended:${paymentId}`, {
      action: "topup.while-suspended",
      at: input.nowMs,
      cents: verified.usdCents,
    });
  }
  return { receipt, intent: publicPaymentIntent(intent) };
}
export async function productReceipts(storage: ProductStorage) {
  return (await readIntents(storage))
    .flatMap(
      (intent) => intent.receipts ?? (intent.receipt ? [intent.receipt] : []),
    )
    .reverse();
}
export async function unmatchedPayments(
  storage: Pick<DurableObjectTransaction, "list">,
): Promise<UnmatchedPayment[]> {
  const rows = await storage.list<UnmatchedPayment>({
    prefix: UNMATCHED_PREFIX,
    limit: UNMATCHED_MAX + 1,
  });
  return [...rows]
    .filter(([key]) => key !== `${UNMATCHED_PREFIX}count`)
    .map(([, row]) => row);
}
export async function answerUnmatched(
  storage: ProductStorage,
  input: {
    paymentId: string;
    action: "credit" | "return";
    usdCents?: number;
    nowMs: number;
    operator: ChatPrincipalId;
    env?: TemplStaffEnv;
  },
) {
  const key = `${UNMATCHED_PREFIX}${input.paymentId}`,
    row = await storage.get<UnmatchedPayment>(key);
  if (!row || row.status !== "open")
    throw new HttpError(404, "No open unmatched payment with that ID.");
  if (input.action === "credit") {
    if (row.creditEligible !== true || input.usdCents !== row.usdCents)
      throw new HttpError(409, "This transfer needs verified payment details.");
    if (row.settlement === "standard-prepaid")
      await creditPrepaid(storage, {
        receiptId: row.paymentId,
        amountUsdNanos: (BigInt(row.usdCents) * 10_000_000n).toString(),
        at: input.nowMs,
      });
    else if (row.settlement === "manual-usage")
      await settleUsagePayment(storage, {
        id: `payment:${row.paymentId}`,
        paymentId: row.paymentId,
        cents: input.usdCents,
        at: input.nowMs,
        operator: input.operator,
        reason: "Verified transfer matched by an operator",
      });
    else
      await creditTopUp(storage, {
        paymentId: row.paymentId,
        usdCents: input.usdCents ?? -1,
        paidAt: row.at,
        nowMs: input.nowMs,
        operator: true,
        env: input.env,
      });
    row.status = "credited";
    row.creditedCents = input.usdCents;
  } else row.status = "returned";
  row.answeredBy = input.operator;
  await storage.put(key, row);
  await recordProductEvent(storage, `unmatched:${row.paymentId}`, {
    action:
      input.action === "credit" ? "unmatched.credited" : "unmatched.returned",
    at: input.nowMs,
    operator: input.operator,
    ...(input.usdCents ? { cents: input.usdCents } : {}),
  });
  return row;
}
export async function reconcileProductAfterRestore(
  storage: ProductStorage,
  before: unknown,
  nowMs: number,
  env: TemplStaffEnv = {},
) {
  if (!(await storage.get(PRODUCT_STATE_KEY))) return 0;
  const earlier = before as {
      creditedPayments?: unknown;
      suspended?: { at?: unknown } | null;
      pauseWaived?: unknown;
      cardCoverage?: unknown;
    } | null,
    credited = Array.isArray(earlier?.creditedPayments)
      ? earlier.creditedPayments.filter(
          (id): id is string =>
            typeof id === "string" && !id.startsWith("grant:"),
        )
      : [],
    receipts = new Map(
      (await productReceipts(storage)).map((row) => [row.paymentId, row]),
    );
  let restored = 0;
  for (const paymentId of credited) {
    if (
      (await readProductState(storage, nowMs, env)).creditedPayments.includes(
        paymentId,
      )
    )
      continue;
    const receipt = receipts.get(paymentId),
      unmatched = await storage.get<UnmatchedPayment>(
        `${UNMATCHED_PREFIX}${paymentId}`,
      );
    if (receipt)
      await creditTopUp(storage, {
        paymentId,
        usdCents: receipt.usdCents,
        paidAt: Date.parse(receipt.paidAt),
        nowMs,
        orderForm: Boolean(receipt.orderFormId),
        env,
      });
    else if (unmatched?.status === "credited" && unmatched.creditedCents)
      await creditTopUp(storage, {
        paymentId,
        usdCents: unmatched.creditedCents,
        paidAt: unmatched.at,
        nowMs,
        operator: true,
        env,
      });
    else continue;
    restored++;
  }
  const state = await readProductState(storage, nowMs, env);
  if (earlier?.suspended && !state.suspended)
    state.suspended = {
      at: Number.isSafeInteger(earlier.suspended.at)
        ? (earlier.suspended.at as number)
        : nowMs,
    };
  if (earlier?.pauseWaived === true) state.pauseWaived = true;
  if (earlier?.cardCoverage === true || state.cardCoverage !== undefined)
    state.cardCoverage = earlier?.cardCoverage === true;
  await storage.put(PRODUCT_STATE_KEY, state);
  return restored;
}

export async function refreshProductPaymentTransaction(
  storage: ProductStorage,
  env: ProductBillingEnv,
  id: string,
  nowMs: number,
  _fetcher?: PaymentFetcher,
  scanner: ProductPaymentScannerDeferral = {},
) {
  const intent = await productPaymentRequest(storage, id);
  if (!intent) throw new HttpError(404, "Payment request not found.");
  await requireProductPaymentRail(env, intent.rail, storage);
  if (
    !["open", "seen"].includes(intent.status) ||
    Date.parse(intent.expiresAt) <= nowMs
  )
    throw new HttpError(409, "This payment request has expired or closed.");
  if (intent.verificationReviewRequired)
    throw new HttpError(
      409,
      "This transfer needs a payment review. Do not send it again.",
      undefined,
      "product-payment-review-required",
    );
  if (intent.kind === "solana") {
    if (scanner.deferScanner && !scanner.scannerResult) {
      scanner.deferScanner({
        action: "blockhash",
        intent: publicPaymentIntent(intent),
      });
      return { intent: publicPaymentIntent(intent) };
    }
    if (
      scanner.scannerResult &&
      (scanner.scannerResult.action !== "blockhash" ||
        scanner.scannerResult.requestId !== id)
    )
      throw new HttpError(409, "The payment request changed. Review it again.");
    if (!scanner.scannerResult && intent.settlement === "standard-prepaid")
      await paymentScannerCall(env, intent.network, "register", {
        intent: publicPaymentIntent(intent),
      });
    const blockhash =
      scanner.scannerResult?.value ??
      (await paymentScannerCall(env, intent.network, "blockhash", {
        requestId: id,
      }));
    if (
      !isSolanaAddress(blockhash.recentBlockhash) ||
      !Number.isSafeInteger(blockhash.lastValidBlockHeight)
    )
      throw unavailable();
    intent.recentBlockhash = blockhash.recentBlockhash;
    intent.lastValidBlockHeight = Number(blockhash.lastValidBlockHeight);
    await storage.put(`${INTENT_PREFIX}${id}`, intent);
  }
  return { intent: publicPaymentIntent(intent) };
}

export type InboundProductTransfer = {
  usdCents: number | null;
  creditEligible: boolean;
  paymentId: string;
  network: ProductPaymentNetwork;
  txHash: string;
  rail: ProductRailId;
  asset: string;
  payer: string;
  recipient: string;
  amountRaw: string;
  logIndex?: number;
  instructionIndex?: number;
  paidAt: number;
  reason: string;
  status: "open";
};
/** Receiver discovery retains final transfers that have no open payer
 * request. They enter an operator queue and never credit a workspace. */
export async function verifyInboundProductPayment(
  env: ProductBillingEnv,
  network: ProductPaymentNetwork,
  tx: string,
  input: { nowMs: number; fetcher?: PaymentFetcher; rpc?: ProductPaymentRpc },
): Promise<InboundProductTransfer[]> {
  env = productPaymentRpcEnv(env);
  const configs = Object.entries(paymentRecipients(env)).filter(
    ([rail, row]) => {
      if (row.chain !== network) return false;
      try {
        requireProductPaymentRail(env, rail);
        return true;
      } catch {
        return false;
      }
    },
  ) as [ProductRailId, NonNullable<ProductPaymentRecipients[ProductRailId]>][];
  if (!configs.length) throw unavailable();
  if (network === "solana") {
    const urls = (await import("./solana")).solanaEndpoints(
        env as SolanaRpcEnv,
      ),
      params = [
        tx,
        {
          encoding: "jsonParsed",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        },
      ];
    const [transactions, geneses] = await Promise.all([
      Promise.all(
        urls.map((url) =>
          (input.rpc ?? paymentRpc)(
            env,
            url,
            "getTransaction",
            params,
            input.fetcher,
          ),
        ),
      ),
      Promise.all(
        urls.map((url) =>
          (input.rpc ?? paymentRpc)(
            env,
            url,
            "getGenesisHash",
            [],
            input.fetcher,
          ),
        ),
      ),
    ]);
    const { PRODUCT_SOLANA_GENESIS, PRODUCT_SOLANA_TOKEN_PROGRAM } =
      await import("@templ/chat/product-payment");
    if (geneses.some((value) => value !== PRODUCT_SOLANA_GENESIS))
      throw unavailable();
    if ((transactions[0] === null) !== (transactions[1] === null))
      throw new HttpError(503, "Independent payment reads disagree.");
    if (transactions.every((value) => value === null))
      throw new HttpError(
        409,
        "The transfer is still confirming.",
        undefined,
        "product-payment-receipt-missing",
      );
    const canonical = (value: unknown): string =>
      Array.isArray(value)
        ? JSON.stringify(value.map(canonical))
        : value && typeof value === "object"
          ? JSON.stringify(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, row]) => [key, canonical(row)]),
            )
          : JSON.stringify(value);
    if (canonical(transactions[0]) !== canonical(transactions[1]))
      throw new HttpError(503, "Independent payment reads disagree.");
    const result = transactions[0] as any;
    if (
      !result?.meta ||
      result.meta.err !== null ||
      !Array.isArray(result.transaction?.message?.instructions) ||
      result.transaction.message.instructions.length > 256 ||
      result.transaction.signatures?.[0] !== tx ||
      !Number.isSafeInteger(result.blockTime) ||
      !Array.isArray(result.meta.preTokenBalances) ||
      !Array.isArray(result.meta.postTokenBalances)
    )
      throw new HttpError(422, "This transfer could not be matched.");
    const keys = result.transaction.message.accountKeys.map((row: any) =>
        typeof row === "string" ? row : row.pubkey,
      ),
      instructions: { row: any; index: number }[] =
        result.transaction.message.instructions.map(
          (row: any, index: number) => ({ row, index }),
        );
    for (const group of result.meta.innerInstructions ?? [])
      for (const [offset, row] of group.instructions.entries())
        instructions.push({
          row,
          index:
            result.transaction.message.instructions.length +
            group.index * 256 +
            offset,
        });
    const paidAt = result.blockTime * 1000;
    if (!Number.isSafeInteger(paidAt) || paidAt > input.nowMs)
      throw unavailable();
    const transfers = instructions.filter(
      ({ row }) =>
        row.programId === PRODUCT_SOLANA_TOKEN_PROGRAM &&
        ["transfer", "transferChecked"].includes(row.parsed?.type),
    );
    const transferCounts = new Map<string, number>();
    for (const { row } of transfers) {
      for (const account of new Set([
        row.parsed.info?.source,
        row.parsed.info?.destination,
      ])) {
        if (typeof account === "string")
          transferCounts.set(account, (transferCounts.get(account) ?? 0) + 1);
      }
    }
    const hasSharedTransferAccounts = [...transferCounts.values()].some(
      (count) => count > 1,
    );
    const rows: InboundProductTransfer[] = [];
    for (const { row, index } of transfers) {
      const info = row.parsed.info;
      if (
        !info ||
        typeof info.source !== "string" ||
        typeof info.destination !== "string"
      )
        continue;
      const destination = result.meta.postTokenBalances.find(
          (balance: any) =>
            balance.accountIndex === keys.indexOf(info.destination),
        ),
        source = result.meta.preTokenBalances.find(
          (balance: any) => balance.accountIndex === keys.indexOf(info.source),
        ),
        config = configs.find(([, config]) => config.asset === source?.mint);
      if (
        !config ||
        !isSolanaAddress(source.owner) ||
        destination?.owner !== config[1].recipient ||
        destination?.mint !== config[1].asset
      )
        continue;
      const amountRaw =
          row.parsed.type === "transferChecked"
            ? info.tokenAmount?.amount
            : info.amount,
        decimals =
          row.parsed.type === "transferChecked"
            ? info.tokenAmount?.decimals
            : source.uiTokenAmount?.decimals;
      if (
        typeof amountRaw !== "string" ||
        !/^\d{1,78}$/.test(amountRaw) ||
        decimals !== config[1].decimals ||
        (row.parsed.type === "transferChecked" && info.mint !== config[1].asset)
      )
        continue;
      const tokenAmount = (balance: any): bigint | null => {
        const amount = balance?.uiTokenAmount;
        if (!balance) return 0n;
        if (
          balance.mint !== config[1].asset ||
          amount?.decimals !== config[1].decimals ||
          typeof amount.amount !== "string" ||
          !/^\d{1,78}$/.test(amount.amount)
        )
          return null;
        return BigInt(amount.amount);
      };
      const sourceAfter = result.meta.postTokenBalances.find(
          (balance: any) => balance.accountIndex === keys.indexOf(info.source),
        ),
        destinationBefore = result.meta.preTokenBalances.find(
          (balance: any) =>
            balance.accountIndex === keys.indexOf(info.destination),
        ),
        sourcePre = tokenAmount(source),
        sourcePost = tokenAmount(sourceAfter),
        destinationPre = tokenAmount(destinationBefore),
        destinationPost = tokenAmount(destination),
        raw = BigInt(amountRaw),
        units = 10n ** BigInt(config[1].decimals - 2),
        cents = raw / units,
        creditEligible =
          !hasSharedTransferAccounts &&
          sourceAfter?.owner === source.owner &&
          destinationBefore?.owner === config[1].recipient &&
          sourcePre !== null &&
          sourcePost !== null &&
          destinationPre !== null &&
          destinationPost !== null &&
          sourcePre - sourcePost === raw &&
          destinationPost - destinationPre === raw &&
          raw > 0n &&
          raw % units === 0n &&
          cents <= BigInt(PRODUCT_TOP_UP.maxUsdCents);

      rows.push({
        usdCents: creditEligible ? Number(cents) : null,
        creditEligible,
        paymentId: productTransferPaymentId(network, tx, index),
        network,
        txHash: tx,
        rail: config[0],
        asset: config[1].asset,
        payer: source.owner,
        recipient: config[1].recipient,
        amountRaw,
        instructionIndex: index,
        paidAt,
        reason: "No matching payment request",
        status: "open",
      });
    }
    return rows;
  }
  const urls = authorizationEndpoints(env as ChainRpcEnv, network);
  const facts = await Promise.all(
    urls.map(async (url) => {
      const [receipt, head, chain] = await Promise.all([
        (input.rpc ?? paymentRpc)(
          env,
          url,
          "eth_getTransactionReceipt",
          [tx],
          input.fetcher,
        ).then(normalizeReceipt),
        (input.rpc ?? paymentRpc)(
          env,
          url,
          "eth_getBlockByNumber",
          ["finalized", false],
          input.fetcher,
        ).then(block),
        (input.rpc ?? paymentRpc)(env, url, "eth_chainId", [], input.fetcher),
      ]);
      return { receipt, head, chain };
    }),
  );
  if (facts.some((row) => rpcQuantity(row.chain) !== BigInt(network)))
    throw unavailable();
  const [a, b] = facts;
  if ((a.receipt === null) !== (b.receipt === null))
    throw new HttpError(503, "Independent payment reads disagree.");
  if (!a.receipt || !b.receipt)
    throw new HttpError(409, "The transfer is still confirming.");
  if (
    JSON.stringify(a.receipt) !== JSON.stringify(b.receipt) ||
    a.receipt.transactionHash !== tx.toLowerCase()
  )
    throw new HttpError(503, "Independent payment reads disagree.");
  const number = rpcQuantity(a.receipt.blockNumber);
  if (facts.some((row) => number > rpcQuantity(row.head.number)))
    throw new HttpError(409, "The transfer is still confirming.");
  const blocks = await Promise.all(
    urls.map((url) =>
      (input.rpc ?? paymentRpc)(
        env,
        url,
        "eth_getBlockByNumber",
        [toHex(number), false],
        input.fetcher,
      ).then(block),
    ),
  );
  if (
    blocks.some(
      (row) =>
        row.hash !== a.receipt!.blockHash || rpcQuantity(row.number) !== number,
    ) ||
    blocks[0].timestamp !== blocks[1].timestamp
  )
    throw new HttpError(503, "Independent payment reads disagree.");
  const paidAt = Number(rpcQuantity(blocks[0].timestamp)) * 1000;
  if (!Number.isSafeInteger(paidAt) || paidAt > input.nowMs)
    throw unavailable();
  if (a.receipt.status !== "0x1") return [];
  return a.receipt.logs.flatMap((log) => {
    const config = configs.find(
      ([, row]) => row.asset.toLowerCase() === log.address,
    );
    if (
      !config ||
      log.topics[0] !== PRODUCT_TRANSFER_TOPIC ||
      log.topics.length !== 3 ||
      !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[1]) ||
      !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[2]) ||
      `0x${log.topics[2].slice(-40)}` !== config[1].recipient.toLowerCase() ||
      !/^0x[0-9a-f]{64}$/.test(log.data)
    )
      return [];
    const logIndex = Number(rpcQuantity(log.logIndex));
    if (!Number.isSafeInteger(logIndex)) throw unavailable();
    const raw = BigInt(log.data),
      units = 10n ** BigInt(config[1].decimals - 2),
      cents = raw / units,
      creditEligible =
        raw > 0n &&
        raw % units === 0n &&
        cents <= BigInt(PRODUCT_TOP_UP.maxUsdCents);
    return [
      {
        usdCents: creditEligible ? Number(cents) : null,
        creditEligible,
        paymentId: productTransferPaymentId(network, tx, logIndex),
        network,
        txHash: tx.toLowerCase(),
        rail: config[0],
        asset: config[1].asset,
        payer: getAddress(`0x${log.topics[1].slice(-40)}`),
        recipient: config[1].recipient,
        amountRaw: BigInt(log.data).toString(),
        logIndex,
        paidAt,
        reason: "No matching payment request",
        status: "open" as const,
      },
    ];
  });
}

export const PRODUCT_PAYMENT_REGISTRATION_PREFIX =
  "product-payment-registration-v1:";
type PaymentRegistration = {
  intent: ProductPaymentIntent;
  principalId: ChatPrincipalId;
  replaced: PaymentReservation | null;
};
/** Registration follows the room commit. A stored handoff survives a failed
 * internal request and retries without changing the payment request. */
export async function registerProductPayments(
  storage: ProductStorage & Pick<DurableObjectTransaction, "list" | "delete">,
  env: ProductBillingEnv,
  submitted?: (requestId: string, result: Record<string, unknown>) => void,
): Promise<boolean> {
  const rows = await storage.list<PaymentRegistration>({
    prefix: PRODUCT_PAYMENT_REGISTRATION_PREFIX,
  });
  let pending = false;
  for (const [key, row] of rows) {
    try {
      await requireProductPaymentRail(env, row.intent.rail, storage);
      const current = await paymentLedgerCall(env, "current", {
        payer: row.intent.payer,
        rail: row.intent.rail,
        requestId: row.intent.id,
        workspace: row.intent.workspace,
      });
      if (current.current !== true) {
        await storage.delete(key);
        continue;
      }
      await paymentScannerCall(env, row.intent.network, "register", {
        intent: row.intent,
      });
      if (
        row.intent.settlement === "standard-prepaid" &&
        row.intent.submittedTx
      ) {
        const result = await paymentScannerCall(
          env,
          row.intent.network,
          "submit",
          {
            requestId: row.intent.id,
            tx: row.intent.submittedTx,
          },
        );
        submitted?.(row.intent.id, result);
      }
      if (row.replaced)
        await paymentScannerCall(env, row.intent.network, "close", {
          requestId: row.replaced.requestId,
          status: "replaced",
        });
      await storage.delete(key);
    } catch (error) {
      pending = true;
      console.warn(
        JSON.stringify({
          event: "TEMPL_PAYMENT_REGISTRATION_DELAYED",
          cause: error instanceof HttpError ? error.status : 503,
        }),
      );
    }
  }
  return pending;
}
