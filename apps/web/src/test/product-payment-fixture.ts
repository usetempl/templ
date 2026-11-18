import { getAddress } from "viem";
import {
  getProductPaymentAsset,
  productPaymentAmountRaw,
  productRailOf,
  type EvmProductPaymentIntent,
} from "@templ/chat/product-payment";
import { PRODUCT_OFFER_VERSION, PRODUCT_TOP_UP } from "@templ/chat/plans";
export const paymentRoom = "room:01990000-0000-7000-8000-000000000001" as const;
export const paymentPayer =
  "0x2222222222222222222222222222222222222222" as const;
export const paymentReceiver =
  "0x9999999999999999999999999999999999999999" as const;
export const paymentHash = `0x${"a".repeat(64)}` as const;
export function paymentIntent(
  input: Partial<EvmProductPaymentIntent> = {},
): EvmProductPaymentIntent {
  const network = input.chainId ?? 8453;
  const configured = getProductPaymentAsset(network, "USDC")!;
  const usdCents = input.usdCents ?? PRODUCT_TOP_UP.minUsdCents;
  return {
    id: crypto.randomUUID(),
    kind: "evm",
    room: paymentRoom,
    workspace: paymentRoom,
    chainId: network,
    network,
    token: "USDC",
    rail: productRailOf(network, "USDC")!,
    payer: paymentPayer,
    recipient: paymentReceiver,
    offerVersion: PRODUCT_OFFER_VERSION,
    status: "open",
    expectedFinalitySeconds: 1200,
    usdCents,
    amountRaw: productPaymentAmountRaw(usdCents, configured.decimals),
    asset: { ...configured, address: getAddress(configured.address) },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    preview: {
      usdCents,
      bonusCents: 0,
      balanceBeforeCents: 0,
      balanceAfterCents: usdCents,
      calculatedAt: new Date().toISOString(),
    },
    ...input,
  };
}
