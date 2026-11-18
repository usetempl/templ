import type { ProductPaymentIntent } from "@templ/chat/product-payment";
import { PAYMENT_MISMATCH } from "./product-offer";

/** Invoice credit changes the transfer amount, never the reviewed request fields. */
export function productPaymentAmount(intent: ProductPaymentIntent) {
  if (!intent.orderFormId)
    return { usdCents: intent.usdCents, amountRaw: intent.amountRaw };
  const credited = intent.creditedCents ?? 0;
  if (
    !Number.isSafeInteger(intent.usdCents) ||
    intent.usdCents <= 0 ||
    !Number.isSafeInteger(credited) ||
    credited < 0
  )
    throw new Error(PAYMENT_MISMATCH);
  const usdCents = Math.max(0, intent.usdCents - credited);
  return {
    usdCents,
    amountRaw: (
      BigInt(usdCents) *
      10n ** BigInt(intent.asset.decimals - 2)
    ).toString(),
  };
}

export function productPaymentTransferAmount(intent: ProductPaymentIntent) {
  const amount = productPaymentAmount(intent);
  if (amount.usdCents <= 0)
    throw new Error("This payment request has no amount left.");
  return amount;
}
