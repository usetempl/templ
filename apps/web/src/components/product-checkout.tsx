"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ChatRoomId } from "@templ/chat/index";
import { topUpBonusCents } from "@templ/chat/resolution-pricing";
import { PRODUCT_ANNUAL_PRICES, PRODUCT_STARTER_PRICES, PRODUCT_STANDARD_PRICES, PRODUCT_STANDARD_AI_RATES, PRODUCT_TOP_UP } from "@templ/chat/plans";
import { starterPricesForVersion } from "@templ/chat/standard-plan";
import type { MonthlySupportPlan } from "@templ/chat/standard-plan";
import {
  PRODUCT_CHECKOUT_OPTIONS,
  ANNUAL_PAYMENT_NETWORKS,
  getProductPaymentAsset,
  productRailOf,
  type ProductPaymentNetwork,
  type ProductPaymentAssetSymbol,
  type ProductPaymentIntent,
} from "@templ/chat/product-payment";
import {
  TOP_UP_BONUS,
  TOP_UP_BOUNDS,
  TOP_UP_SUGGESTIONS,
  balanceLabel,
  isBillingView,
  topUpCents,
} from "@/lib/product-offer";
import { formatUsd, prepaidAiRateText } from "@/lib/product-format";
import { communitySessionRevision } from "@/lib/community-auth";
import { useChatAuth } from "@/lib/chat-auth";
import { useWallet, walletError } from "@/lib/wallet";
import {
  prepareProductPayment,
  submitProductReceipt,
  readProductPaymentRequests,
  checkProductPayment,
  refreshProductPaymentTransaction,
  type ProductUsage,
} from "@/lib/product-client";
import {
  productCheckoutAvailable,
  sendProductPayment,
  sendSolanaProductPayment,
  validProductTransactionHash,
  clearProductPayment,
  checkProductPaymentIntent,
  pendingProductPayment,
  pendingProductPaymentFor,
} from "@/lib/product-payment";
import { watchProductPayments } from "@/lib/product-payment-live";
import { readProductPaymentStatus } from "@/lib/product-payment-status";
import { CommunityApiError } from "@/lib/community-client";
import { trackEvent } from "@/lib/analytics";
import { productPaymentAmount } from "@/lib/product-payment-amount";
import { CheckoutPaymentPayer } from "./checkout-payment-payer";
import {
  ProductPaymentRequestDetails,
  paymentNetworkName,
} from "./product-payment-request";
import styles from "./add-balance-dialog.module.css";

const networks = [
  ...new Set(PRODUCT_CHECKOUT_OPTIONS.map(({ network }) => network)),
];
function retainVerifiedPayment(
  current: ProductPaymentIntent | undefined,
  updated: ProductPaymentIntent | undefined,
) {
  return current?.status === "credited" && current.id === updated?.id
    ? current
    : updated;
}
type CheckoutProps = {
  room: ChatRoomId;
  usage?: ProductUsage;
  assertCurrent: () => void;
  onConfirmed: (payment: ProductPaymentIntent) => void;
  purpose?: "period" | "credit";
  request?: ProductPaymentIntent;
};
export function ProductCheckout(props: CheckoutProps) {
  const auth = useChatAuth();
  return (
    <Checkout
      key={`${props.room}:${auth.session?.principalId}:${props.purpose}:${props.request?.id}:${props.usage && isBillingView(props.usage) && props.usage.standardPlan ? `standard:${props.usage.standardPlan.period?.id}:${props.usage.standardPlan.status}` : props.usage && isBillingView(props.usage) && props.usage.usageBilling ? "usage" : "prepaid"}`}
      {...props}
    />
  );
}
function Checkout({
  room,
  usage,
  assertCurrent,
  onConfirmed,
  purpose,
  request,
}: CheckoutProps) {
  const auth = useChatAuth();
  const wallet = useWallet();
  const features = usage?.features;
  const manualUsage =
    usage && isBillingView(usage) ? usage.usageBilling : undefined;
  const standard =
    usage && isBillingView(usage) ? usage.standardPlan : undefined;
  const agreedAiBilling = (standard?.prepaid?.mode ?? "prepaid") !== "prepaid";
  const [standardPurpose, setStandardPurpose] = useState<
    "period" | "credit" | null
  >(() =>
    standard
      ? standard.status === "paid"
        ? "credit"
        : (purpose ?? "period")
      : null,
  );
  const expectedPeriod = standard?.period?.id ?? null;
  const [monthlyPlan, setMonthlyPlan] = useState<MonthlySupportPlan>(() =>
    standard?.starterAvailable &&
    (!expectedPeriod || starterPricesForVersion(standard.period?.usage?.priceVersion))
      ? "starter"
      : "standard",
  );
  const [term, setTerm] = useState<"monthly" | "annual">("monthly");
  const annualNetwork = standard?.annualAvailable && ANNUAL_PAYMENT_NETWORKS.find(network => productCheckoutAvailable(network, "USDC", features));
  const annual = standardPurpose === "period" && Boolean(annualNetwork) && term === "annual";
  const requestedPurpose = annual ? "annual" : standardPurpose;
  const monthlyPrices = monthlyPlan === "starter" ? PRODUCT_STARTER_PRICES : PRODUCT_STANDARD_PRICES;
  const checkoutCard = monthlyPlan === "starter" ? PRODUCT_STARTER_PRICES.aiRateCardVersion : PRODUCT_STANDARD_AI_RATES.version;
  const accessCents = annual ? PRODUCT_ANNUAL_PRICES[monthlyPlan] : monthlyPrices.workspaceMonthlyUsdCents;
  const [dollars, setDollars] = useState(() =>
    String(
      (standardPurpose === "period"
        ? accessCents
        : standardPurpose === "credit"
          ? Math.min(
              standard?.dueCents ||
                PRODUCT_STANDARD_PRICES.includedAiCreditUsdCents,
              PRODUCT_TOP_UP.maxUsdCents,
            )
          : (manualUsage?.dueCents ?? TOP_UP_SUGGESTIONS[0])) / 100,
    ),
  );
  const manualCents = /^\d{1,5}(?:\.\d{1,2})?$/.test(dollars.trim())
    ? Math.round(Number(dollars) * 100)
    : 0;
  const usdCents =
    standardPurpose === "period"
      ? accessCents
      : standardPurpose === "credit"
        ? manualCents > 0 && manualCents <= PRODUCT_TOP_UP.maxUsdCents
          ? manualCents
          : null
        : manualUsage
          ? manualCents > 0 && manualCents <= 100_000
            ? manualCents
            : null
          : topUpCents(dollars);
  const balanceCents =
    usage && isBillingView(usage) ? usage.balance.balanceCents : 0;
  const bonusCents =
    usdCents === null || manualUsage || standardPurpose
      ? 0
      : topUpBonusCents(usdCents, balanceCents);
  const [chainId, setChainId] = useState<ProductPaymentNetwork>(() =>
    standardPurpose
      ? (([8453, 1, 56, "solana"] as const).find((network) =>
          productCheckoutAvailable(network, "USDC", features),
        ) ?? 8453)
      : 8453,
  );
  const [symbol, setSymbol] = useState<ProductPaymentAssetSymbol>("USDC");
  const [payer, setPayer] = useState<string>();
  const [intent, setIntent] = useState(request);
  const [requests, setRequests] = useState<ProductPaymentIntent[]>([]);
  const [hash, setHash] = useState(request?.submittedTx ?? "");
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [phase, setPhase] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [, setJournalRevision] = useState(0);
  const running = useRef(false);
  const selection = `${room}:${auth.session?.principalId}:${chainId}:${symbol}:${payer}:${requestedPurpose}:${monthlyPlan}:${expectedPeriod}:${dollars}:${communitySessionRevision()}`;
  const current = useRef(selection);
  current.current = selection;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A plan payment asks an email account to sign in with its wallet. That
  // refusal goes once the wallet session arrives.
  const authMethod = auth.session?.authMethod;
  useEffect(() => {
    setError("");
  }, [authMethod]);
  useEffect(() => {
    const controller = new AbortController();
    void readProductPaymentStatus(
      (signal) => readProductPaymentRequests(room, signal),
      controller.signal,
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        for (const request of result.requests) {
          if (!["open", "seen"].includes(request.status))
            clearProductPayment(request);
        }
        setRequests(result.requests);
        setIntent((selected) =>
          selected
            ? retainVerifiedPayment(
                selected,
                result.requests.find((request) => request.id === selected.id) ??
                  selected,
              )
            : result.requests.find(
                (request) =>
                  ["open", "seen"].includes(request.status) &&
                  Boolean(
                    request.submittedTx || pendingProductPayment(request)?.hash,
                  ),
              ),
        );
      },
      () => {},
    );
    return () => controller.abort();
  }, [room, auth.session?.principalId, revision]);
  useEffect(
    () => watchProductPayments(room, () => setRevision((v) => v + 1)),
    [room, auth.session?.principalId],
  );
  useEffect(() => {
    if (!intent || intent.status !== "open" || intent.submittedTx) return;
    const processed = intent.processedTransaction;
    const pending = pendingProductPayment(intent);
    if (
      !processed ||
      !["unmatched", "credited"].includes(processed.outcome) ||
      !pending?.hash ||
      pending.uncertain
    )
      return;
    const sameTransaction = (value: string) =>
      intent.kind === "evm"
        ? value.toLowerCase() === processed.tx.toLowerCase()
        : value === processed.tx;
    if (!sameTransaction(pending.hash)) return;
    clearProductPayment(intent);
    setHash((value) => (sameTransaction(value) ? "" : value));
    setJournalRevision((value) => value + 1);
  }, [intent]);
  const confirmed = useRef(new Set<string>());
  useEffect(() => {
    if (
      !intent ||
      intent.status !== "credited" ||
      confirmed.current.has(intent.id)
    )
      return;
    confirmed.current.add(intent.id);
    clearProductPayment(intent);
    setError("");
    setStatusError("");
    setPhase("");
    trackEvent("payment_confirmed");
    onConfirmed(intent);
  }, [intent, onConfirmed]);
  const enabled = productCheckoutAvailable(
    intent?.chainId ?? chainId,
    intent?.asset.symbol ?? symbol,
    features,
  );
  const saved = intent ? pendingProductPayment(intent) : null;
  const expired = intent ? Date.parse(intent.expiresAt) <= Date.now() : false;
  const amountLeft = intent ? productPaymentAmount(intent).usdCents : 0;
  const needsWallet =
    intent?.kind === "evm" &&
    (wallet.walletChoiceRequired ||
      !wallet.account ||
      wallet.account.toLowerCase() !== intent.payer.toLowerCase());
  const paymentId = intent?.id;
  const standardPayment = intent?.settlement === "standard-prepaid";
  const resumeHash =
    standardPayment && !intent?.submittedTx ? saved?.hash : undefined;
  const awaitingConfirmation = Boolean(
    intent &&
    ["open", "seen"].includes(intent.status) &&
    (intent.submittedTx || saved?.hash) &&
    !expired &&
    !intent.verificationReviewRequired,
  );
  useEffect(() => {
    if (!paymentId || !awaitingConfirmation) return;
    const controller = new AbortController();
    const capturedRevision = communitySessionRevision();
    const capturedSelection = selection;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const check = () => {
      controller.signal.throwIfAborted();
      assertCurrent();
      if (
        current.current !== capturedSelection ||
        communitySessionRevision() !== capturedRevision
      )
        throw new Error("Your workspace or account changed.");
    };
    async function refreshStatus() {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => void refreshStatus(), 30_000);
        return;
      }
      if (running.current) {
        timer = setTimeout(() => void refreshStatus(), 15_000);
        return;
      }
      let delay = 15_000;
      try {
        check();
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]);
        let updated: ProductPaymentIntent | undefined;
        if (resumeHash) {
          try {
            const result = await submitProductReceipt(
              auth.session?.principalId,
              room,
              { requestId: paymentId!, tx: resumeHash },
              check,
              signal,
            );
            check();
            if ("unmatched" in result) {
              setStatusError(result.unmatched.message);
              return;
            }
            updated = result.intent;
            if (!updated)
              updated = (
                await readProductPaymentRequests(room, signal)
              ).requests.find((request) => request.id === paymentId);
          } catch (reason) {
            if (
              reason instanceof CommunityApiError &&
              reason.status === 409 &&
              (reason.details as { reason?: string })?.reason ===
                "product-payment-confirming"
            )
              updated = (reason.details as { intent?: ProductPaymentIntent })
                .intent;
            else throw reason;
          }
        } else if (standardPayment)
          updated = (
            await checkProductPayment(
              auth.session?.principalId,
              room,
              paymentId!,
              check,
              signal,
            )
          ).intent;
        else
          updated = (
            await readProductPaymentRequests(room, signal)
          ).requests.find((request) => request.id === paymentId);
        check();
        if (
          !updated ||
          updated.id !== paymentId ||
          updated.room !== room ||
          updated.workspace !== room
        )
          throw new Error("The payment request could not be refreshed.");
        setStatusError("");
        setError("");
        failures = 0;
        setIntent((selected) =>
          selected?.id === paymentId
            ? retainVerifiedPayment(selected, updated)
            : selected,
        );
        if (
          !["open", "seen"].includes(updated.status) ||
          updated.verificationReviewRequired
        )
          return;
        delay = Math.min(
          300_000,
          Math.max(
            15_000,
            (updated.nextCheckAt ?? Date.now() + 30_000) - Date.now(),
          ),
        );
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (
          current.current !== capturedSelection ||
          communitySessionRevision() !== capturedRevision
        )
          return;
        if (
          reason instanceof CommunityApiError &&
          [400, 401, 403, 404, 410].includes(reason.status)
        ) {
          setStatusError("Reopen this payment request to check its status.");
          return;
        }
        if (
          reason instanceof CommunityApiError &&
          (reason.details as { reason?: string })?.reason ===
            "product-payment-review-required"
        ) {
          setIntent((selected) =>
            selected && selected.id === paymentId
              ? { ...selected, verificationReviewRequired: true }
              : selected,
          );
          return;
        }
        failures += 1;
        if (failures === 1)
          console.warn("TEMPL_SUPPORT_FAILURE", {
            route: "payment",
            step: "status",
            cause: "read-failed",
          });
        delay = Math.min(60_000, 10_000 * 2 ** Math.min(failures, 3));
        if (reason instanceof CommunityApiError && reason.status === 429)
          delay = Math.max(
            delay,
            Math.min(300_000, (reason.retryAfterSeconds ?? 30) * 1_000),
          );
        setStatusError(
          "Payment checks are temporarily unavailable. We’ll retry automatically. Do not send another transfer.",
        );
      }
      if (Date.now() - startedAt < 45 * 60_000)
        timer = setTimeout(() => void refreshStatus(), delay);
      else
        setStatusError(
          "This payment is still confirming. Reopen this request to check again. Do not send another transfer.",
        );
    }
    timer = setTimeout(() => void refreshStatus(), 5_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    paymentId,
    awaitingConfirmation,
    standardPayment,
    resumeHash,
    room,
    auth.session?.principalId,
    selection,
    assertCurrent,
  ]);
  async function run(
    step: "prepare" | "connect" | "send" | "submit" | "check",
    work: (check: () => void) => Promise<void>,
  ) {
    if (running.current) return;
    running.current = true;
    const captured = selection;
    const capturedRevision = communitySessionRevision();
    setBusy(true);
    setError("");
    const check = () => {
      assertCurrent();
      if (
        !mounted.current ||
        current.current !== captured ||
        communitySessionRevision() !== capturedRevision
      )
        throw new Error(
          "Your workspace, account or payment selection changed.",
        );
    };
    try {
      check();
      await work(check);
      setStatusError("");
    } catch (reason) {
      if (
        (step === "check" || step === "submit") &&
        intent &&
        confirmed.current.has(intent.id)
      )
        return;
      if (mounted.current && current.current === captured) {
        if (
          reason instanceof CommunityApiError &&
          reason.status === 409 &&
          (reason.details as { reason?: string })?.reason ===
            "product-payment-confirming"
        ) {
          setRevision((v) => v + 1);
        } else {
          setError(
            ((reason instanceof CommunityApiError && reason.status >= 500) ||
              (reason instanceof DOMException &&
                ["TimeoutError", "AbortError"].includes(reason.name))) &&
              (step === "check" || step === "submit")
              ? "Payment checks are temporarily unavailable. We’ll retry automatically. Do not send another transfer."
              : step === "connect"
                ? walletError(reason)
                : reason instanceof Error
                  ? reason.message
                  : "The payment could not be checked.",
          );
          trackEvent("payment_failed");
          console.warn("TEMPL_SUPPORT_FAILURE", {
            route: "payment",
            step,
            cause:
              reason instanceof CommunityApiError
                ? "service-refused"
                : "wallet-or-connection-failed",
          });
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        setPhase("");
      }
    }
  }
  async function submit(check: () => void, tx: string) {
    if (!intent) return;
    check();
    setPhase("Checking your transfer.");
    try {
      const result = await submitProductReceipt(
        auth.session?.principalId,
        room,
        { requestId: intent.id, tx },
        check,
        AbortSignal.timeout(20_000),
      );
      check();
      if ("unmatched" in result) throw new Error(result.unmatched.message);
      if (result.receipt && result.receipt.requestId !== intent.id) {
        clearProductPayment(intent);
        setHash("");
        setError("This transaction was already credited.");
      }
      if (
        result.receipt &&
        result.receipt.requestId === intent.id &&
        result.intent &&
        result.intent.orderFormId &&
        result.intent.status === "open"
      ) {
        clearProductPayment(intent);
        setHash("");
      }
      if (result.intent)
        setIntent((selected) => retainVerifiedPayment(selected, result.intent));
      else if (result.receipt?.requestId === intent.id)
        setIntent({ ...intent, status: "credited" });
    } catch (reason) {
      if (
        reason instanceof CommunityApiError &&
        reason.status === 409 &&
        (reason.details as { reason?: string })?.reason ===
          "product-payment-confirming"
      ) {
        check();
        const updated = (reason.details as { intent?: ProductPaymentIntent })
          .intent;
        if (
          updated?.id === intent.id &&
          updated.room === room &&
          updated.workspace === room &&
          (updated.status === "seen" ||
            (updated.status === "open" && Boolean(updated.submittedTx)))
        )
          setIntent((selected) => retainVerifiedPayment(selected, updated));
        else
          setIntent((selected) =>
            retainVerifiedPayment(selected, { ...intent, submittedTx: tx }),
          );
      } else throw reason;
    }
    setRevision((v) => v + 1);
  }
  const restorePending = useCallback((address: string) => {
    const previous = pendingProductPaymentFor(room, address);
    if (!previous) return false;
    const restored = requests.find((item) => item.id === previous.intent.id) ?? previous.intent;
    checkProductPaymentIntent(room, restored, address, features);
    setIntent(restored);
    setHash(restored.submittedTx ?? previous.hash ?? "");
    return true;
  }, [room, requests, features]);
  const choosePayer = useCallback((address: string | undefined) => {
    setPayer(address);
    if (!address) return;
    try {
      restorePending(address);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review the pending payment again.");
    }
  }, [restorePending]);
  const locked = busy || Boolean(intent);
  const choosingPlan = purpose === "period" && standardPurpose === "period";
  return (
    <div className={styles.checkout}>
      {!intent && (
        <>
          {standard && standard.status !== "paid" && !choosingPlan && (
            <label>
              Payment type
              <select
                value={standardPurpose ?? "period"}
                disabled={locked}
                onChange={(event) => {
                  const purpose =
                    event.target.value === "credit" ? "credit" : "period";
                  setStandardPurpose(purpose);
                  setDollars(
                    String(
                      (purpose === "period"
                        ? monthlyPrices.workspaceMonthlyUsdCents
                        : PRODUCT_STANDARD_PRICES.includedAiCreditUsdCents) /
                        100,
                    ),
                  );
                }}
              >
                <option value="period">Monthly access</option>
                <option value="credit">Prepaid credit</option>
              </select>
            </label>
          )}
          {standardPurpose === "credit" && (
            <p className={styles.note}>
              Your payment covers recorded charges first. The rest stays as
              credit. Adding credit does not start or renew monthly access.
            </p>
          )}
          {standardPurpose === "period" ? (
            <>
              {annualNetwork && (
                <fieldset className={styles.termChoice} disabled={locked}>
                  <legend>Billing period</legend>
                  <div>
                    <label><input type="radio" name="payment-term" checked={!annual} onChange={() => setTerm("monthly")} />Monthly</label>
                    <label><input type="radio" name="payment-term" checked={annual} onChange={() => {
                      if (!ANNUAL_PAYMENT_NETWORKS.includes(chainId)) setChainId(annualNetwork);
                      setTerm("annual");
                    }} />Annually · 2 months free</label>
                  </div>
                </fieldset>
              )}
              {standard?.starterAvailable && (
                <label>
                  Plan
                  <select
                    value={monthlyPlan}
                    disabled={locked}
                    onChange={(event) =>
                      setMonthlyPlan(event.target.value === "starter" ? "starter" : "standard")
                    }
                  >
                    <option value="starter">Starter · {(annual ? PRODUCT_ANNUAL_PRICES.starter : PRODUCT_STARTER_PRICES.workspaceMonthlyUsdCents) / 100} USDC/{annual ? "year" : "month"}</option>
                    <option value="standard">Plus · {(annual ? PRODUCT_ANNUAL_PRICES.standard : PRODUCT_STANDARD_PRICES.workspaceMonthlyUsdCents) / 100} USDC/{annual ? "year" : "month"}</option>
                  </select>
                </label>
              )}
              <p className={styles.note}>
                {monthlyPrices.includedAnsweredCasesPerMonth} answered cases per month.{" "}
                {agreedAiBilling ? "Your billing agreement sets AI charges." : <>
                  {formatUsd(monthlyPrices.includedAiCreditUsdCents)} AI credit included each month. AI usage costs {prepaidAiRateText(monthlyPrices, checkoutCard)}.
                </>}
              </p>
            </>
          ) : (
            <fieldset className={styles.topUp} disabled={locked}>
              <legend>
                {standardPurpose === "credit"
                  ? "Add prepaid USDC"
                  : manualUsage
                    ? "Pay your amount due"
                    : "Add to your balance"}
              </legend>
              <div className={styles.amounts}>
                {(standardPurpose === "credit"
                  ? [1000, 2000, 5000]
                  : manualUsage
                    ? [manualUsage.dueCents].filter(
                        (cents) => cents > 0 && cents <= 100_000,
                      )
                    : TOP_UP_SUGGESTIONS
                ).map((cents) => (
                  <label key={cents} className={styles.amount}>
                    <input
                      type="radio"
                      name="top-up-amount"
                      value={cents}
                      checked={usdCents === cents}
                      onChange={() => setDollars(String(cents / 100))}
                    />
                    <span>{formatUsd(cents)}</span>
                  </label>
                ))}
              </div>
              <label>
                Amount in dollars
                <input
                  inputMode="decimal"
                  value={dollars}
                  aria-describedby="top-up-bounds"
                  onChange={(event) => setDollars(event.target.value)}
                />
              </label>
              <p id="top-up-bounds" className={styles.note}>
                {standardPurpose === "credit"
                  ? "Choose an available USDC network below. No bonus credit applies."
                  : manualUsage
                    ? "Pay $0.01 to $1,000 with USDC or USDT on Ethereum, or USDC on Base. No bonus credit applies."
                    : `${TOP_UP_BOUNDS} ${TOP_UP_BONUS}`}
              </p>
            </fieldset>
          )}
          {!choosingPlan && <p id="support-purchase-total" className={styles.total}>
            {usdCents === null ? (
              standardPurpose ? (
                `Enter $0.01 to ${formatUsd(PRODUCT_TOP_UP.maxUsdCents)}.`
              ) : manualUsage ? (
                "Enter $0.01 to $1,000."
              ) : (
                "Enter a whole-dollar amount within the limits."
              )
            ) : (
              <>
                <strong>{formatUsd(usdCents)}</strong>
                {bonusCents > 0 ? ` plus ${formatUsd(bonusCents)} credit` : ""}
                {standardPurpose === "period" ? (
                  annual ? " Your year starts after Templ verifies payment." : " Your month starts after Templ verifies payment."
                ) : standardPurpose === "credit" ? (
                  " Added to your prepaid balance after Templ verifies payment."
                ) : manualUsage ? (
                  ` Your amount due becomes ${formatUsd(Math.max(0, manualUsage.dueCents - usdCents))}. Any excess becomes usage credit.`
                ) : (
                  <>
                    Your balance becomes{" "}
                    {balanceLabel(balanceCents + usdCents + bonusCents)}.
                  </>
                )}
              </>
            )}
          </p>}
          <div className={choosingPlan ? styles.options : undefined}>
          <label>
            Network{" "}
            <select
              value={chainId}
              disabled={locked}
              onChange={(event) =>
                setChainId(
                  event.target.value === "solana"
                    ? "solana"
                    : (Number(event.target.value) as ProductPaymentNetwork),
                )
              }
            >
              {networks
                .filter((network) =>
                  standardPurpose
                    ? (annual ? ANNUAL_PAYMENT_NETWORKS : [1, 8453, 56, "solana"]).includes(network)
                    : !manualUsage || [1, 8453].includes(Number(network)),
                )
                .map((network) => (
                  <option
                    key={network}
                    value={network}
                    disabled={
                      Boolean(standardPurpose) &&
                      !productCheckoutAvailable(network, "USDC", features)
                    }
                  >
                    {paymentNetworkName(network)}
                  </option>
                ))}
            </select>
          </label>
          {standardPurpose ? (!choosingPlan && (
            <p>
              Token: {getProductPaymentAsset(chainId, "USDC")?.label ?? "USDC"}
            </p>
          )) : (
            <label>
              Token{" "}
              <select
                value={symbol}
                disabled={locked}
                onChange={(event) =>
                  setSymbol(event.target.value as ProductPaymentAssetSymbol)
                }
              >
                {(standardPurpose ? ["USDC"] : ["USDC", "USDT"]).map(
                  (asset) => (
                    <option
                      key={asset}
                      value={asset}
                      disabled={
                        !getProductPaymentAsset(
                          chainId,
                          asset as ProductPaymentAssetSymbol,
                        )
                      }
                    >
                      {getProductPaymentAsset(
                        chainId,
                        asset as ProductPaymentAssetSymbol,
                      )?.label ?? asset}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
          </div>
          {enabled && (
            <CheckoutPaymentPayer
              compact={choosingPlan}
              principal={auth.session?.principalId}
              network={chainId === "solana" ? "solana" : "evm"}
              value={payer}
              onChange={choosePayer}
              disabled={busy}
            />
          )}
          {enabled ? ((!choosingPlan || payer) && (
            <button
              type="button"
              className={styles.primary}
              disabled={busy || usdCents === null || !payer}
              onClick={() =>
                void run("prepare", async (check) => {
                  if (!payer || usdCents === null) return;
                  const rail = productRailOf(chainId, symbol);
                  if (!rail) return;
                  if (restorePending(payer)) return;
                  const result = await prepareProductPayment(
                    auth.session?.principalId,
                    room,
                    {
                      rail,
                      usdCents,
                      payer,
                      ...(standardPurpose
                        ? {
                            purpose:
                              annual ? ("standard-annual" as const) : standardPurpose === "period"
                                ? ("standard-period" as const)
                                : ("standard-credit" as const),
                            expectedPeriod,
                            ...(standardPurpose === "period" && standard?.starterAvailable
                              ? {
                                  monthlyPlan,
                                  ...(monthlyPlan === "starter" ? { reviewedPriceVersion: monthlyPrices.publishedOn } : {}),
                                }
                              : {}),
                            confirmed: true as const,
                          }
                        : {}),
                    },
                    check,
                  );
                  check();
                  checkProductPaymentIntent(
                    room,
                    result.intent,
                    payer,
                    features,
                  );
                  if (
                    result.intent.usdCents !== usdCents ||
                    result.intent.chainId !== chainId ||
                    result.intent.asset.symbol !== symbol ||
                    (standardPurpose !== null &&
                      (result.intent.settlement !== "standard-prepaid" ||
                        result.intent.standard?.purpose !== requestedPurpose ||
                        result.intent.standard.expectedPeriod !== expectedPeriod ||
                        (standardPurpose === "period" &&
                          (result.intent.standard.priceVersion !== monthlyPrices.publishedOn ||
                           result.intent.standard.aiRateCardVersion !== checkoutCard))))
                  )
                    throw new Error(
                      "The payment selection changed. Review it again.",
                    );
                  setIntent((selected) =>
                    retainVerifiedPayment(selected, result.intent),
                  );
                  trackEvent("checkout_started");
                })
              }
            >
              {busy ? "Preparing…" : choosingPlan ? "Continue to payment" : "Review payment"}
            </button>
          )) : (
            <p className={styles.note}>
              Payments are not open on this network.{" "}
              <Link href="/availability">View availability</Link>.
            </p>
          )}
          {requests
            .filter((request) => ["open", "seen"].includes(request.status))
            .map((request) => (
              <div key={request.id}>
                {request.orderFormId && <p>Payment request from Templ</p>}
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busy}
                  onClick={() => {
                    setIntent(request);
                    setHash(request.submittedTx ?? "");
                  }}
                >
                  Open payment request
                </button>
              </div>
            ))}
        </>
      )}
      {intent && (
        <>
          <ProductPaymentRequestDetails
            agreedAiBilling={agreedAiBilling}
            request={
              intent.status === "open" && !intent.submittedTx && saved?.hash
                ? { ...intent, submittedTx: saved.hash }
                : intent
            }
            recoveryRequired={Boolean(saved?.uncertain)}
            checkoutAction={
              enabled &&
              intent.status === "open" &&
              amountLeft > 0 &&
              !intent.submittedTx &&
              !intent.verificationReviewRequired &&
              !saved?.hash && (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={
                    busy ||
                    Boolean(saved?.uncertain) ||
                    expired ||
                    (intent.kind === "evm" && wallet.restoring)
                  }
                  onClick={() => {
                    if (needsWallet && intent.kind === "evm") {
                      void run("connect", async (check) => {
                        const address = await wallet.connect({
                          selectAccount: Boolean(
                            wallet.account &&
                            wallet.account.toLowerCase() !==
                              intent.payer.toLowerCase(),
                          ),
                        });
                        check();
                        if (
                          address.toLowerCase() !== intent.payer.toLowerCase()
                        )
                          throw new Error(
                            `Select the payment address ${intent.payer.slice(0, 6)}…${intent.payer.slice(-4)} in your wallet.`,
                          );
                      });
                      return;
                    }
                    void run("send", async (check) => {
                      const progress = (message: string) => {
                        check();
                        setPhase(message);
                      };
                      const payable =
                        intent.kind === "solana"
                          ? (
                              await refreshProductPaymentTransaction(
                                auth.session?.principalId,
                                room,
                                intent.id,
                                check,
                              )
                            ).intent
                          : intent;
                      check();
                      if (
                        payable.id !== intent.id ||
                        payable.kind !== intent.kind
                      )
                        throw new Error("The payment request changed.");
                      const tx =
                        payable.kind === "solana"
                          ? await sendSolanaProductPayment({
                              features,
                              room,
                              intent: payable,
                              payer: payable.payer,
                              assertCurrent: check,
                              progress,
                            })
                          : await sendProductPayment({
                              features,
                              room,
                              intent: payable,
                              wallet,
                              assertCurrent: check,
                              progress,
                            });
                      check();
                      setHash(tx);
                      trackEvent("payment_sent");
                      await submit(check, tx);
                    });
                  }}
                >
                  {needsWallet
                    ? wallet.account
                      ? "Select payment wallet"
                      : "Connect payment wallet"
                    : `Pay ${amountLeft / 100} ${intent.asset.symbol}`}
                </button>
              )
            }
            recoveryActions={
              <>
                {["open", "seen"].includes(intent.status) &&
                  !expired &&
                  !intent.submittedTx &&
                  !saved?.hash &&
                  !intent.verificationReviewRequired && (
                    <section className={styles.manual}>
                      <h3>Enter a transfer manually</h3>
                      <label>
                        {intent.kind === "solana"
                          ? "Transaction signature"
                          : "Transaction hash"}
                        <input
                          value={hash}
                          disabled={busy}
                          onChange={(event) => setHash(event.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={
                          busy || !validProductTransactionHash(intent, hash)
                        }
                        onClick={() =>
                          void run("submit", (check) => {
                            trackEvent("payment_hash_submitted");
                            return submit(check, hash);
                          })
                        }
                      >
                        Check transfer
                      </button>
                    </section>
                  )}
                {!intent.submittedTx &&
                  !saved?.hash &&
                  intent.status === "open" && (
                    <button
                      type="button"
                      className={styles.back}
                      disabled={busy}
                      onClick={() => {
                        setIntent(undefined);
                        setHash("");
                      }}
                    >
                      Change payment
                    </button>
                  )}
              </>
            }
            busy={busy}
            onCheck={() =>
              void run("check", async (check) => {
                trackEvent("payment_check_clicked");
                try {
                  const result = await checkProductPayment(
                    auth.session?.principalId,
                    room,
                    intent.id,
                    check,
                    AbortSignal.timeout(15_000),
                  );
                  check();
                  setIntent((selected) =>
                    retainVerifiedPayment(selected, result.intent),
                  );
                } catch (reason) {
                  check();
                  if (
                    reason instanceof CommunityApiError &&
                    reason.status === 409 &&
                    (reason.details as { reason?: string })?.reason ===
                      "product-payment-review-required"
                  )
                    setIntent((selected) =>
                      retainVerifiedPayment(selected, {
                        ...intent,
                        verificationReviewRequired: true,
                      }),
                    );
                  if (
                    reason instanceof CommunityApiError &&
                    reason.status === 429
                  )
                    setIntent((selected) =>
                      retainVerifiedPayment(selected, {
                        ...intent,
                        checkAgainAt:
                          Date.now() + (reason.retryAfterSeconds ?? 30) * 1_000,
                      }),
                    );
                  throw reason;
                }
                setRevision((v) => v + 1);
              })
            }
          />
        </>
      )}
      {phase && intent?.status !== "credited" && (
        <p className={styles.status} role="status">
          {phase}
        </p>
      )}
      {statusError && intent?.status !== "credited" && (
        <p className={styles.status} role="status">
          {statusError}
        </p>
      )}
      {error && intent?.status !== "credited" && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
