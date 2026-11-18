import { getAddress, isAddress, type Address } from "viem";
import type { ChatChainId } from "./chains";
import type { StandardAiRate } from "./standard-usage";
import { PRODUCT_OFFER_VERSION } from "./plans";
import { isSolanaAddress } from "./solana";
import {
  getProductPaymentAsset,
  type ProductPaymentNetwork,
  type ProductPaymentAssetSymbol,
} from "./product-payment-assets";
export * from "./product-payment-assets";

export const PRODUCT_SOLANA_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const PRODUCT_SOLANA_MEMO_PROGRAM =
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const PRODUCT_SOLANA_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const PRODUCT_RAILS = Object.freeze({
  "ethereum-usdc": { network: 1, symbol: "USDC" },
  "ethereum-usdt": { network: 1, symbol: "USDT" },
  "base-usdc": { network: 8453, symbol: "USDC" },
  "bnb-usdc": { network: 56, symbol: "USDC" },
  "bnb-usdt": { network: 56, symbol: "USDT" },
  "solana-usdc": { network: "solana", symbol: "USDC" },
  "solana-usdt": { network: "solana", symbol: "USDT" },
} as const);
export type ProductRailId = keyof typeof PRODUCT_RAILS;
export const PRODUCT_RAIL_IDS = Object.keys(PRODUCT_RAILS) as ProductRailId[];
export type ProductPaymentRecipientConfig = {
  recipient: string;
  asset: string;
  decimals: 6 | 18;
  chain: ProductPaymentNetwork;
};
export type ProductPaymentRecipients = Readonly<
  Partial<Record<ProductRailId, ProductPaymentRecipientConfig>>
>;
export type ProductPaymentRecipient = ProductPaymentRecipientConfig & {
  kind: "evm" | "solana";
  chainId: ProductPaymentNetwork;
  symbol: ProductPaymentAssetSymbol;
};
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function validProductRecipient(
  network: ProductPaymentNetwork,
  recipient: unknown,
  asset: string,
): recipient is string {
  if (typeof recipient !== "string") return false;
  if (
    ["USDC", "USDT"].some((symbol) => {
      const token = getProductPaymentAsset(
        network,
        symbol as ProductPaymentAssetSymbol,
      );
      return (
        token &&
        (network === "solana"
          ? recipient === token.address
          : recipient.toLowerCase() === token.address.toLowerCase())
      );
    })
  )
    return false;
  if (network === "solana")
    return (
      isSolanaAddress(recipient) &&
      recipient !== "11111111111111111111111111111111" &&
      recipient !== "1nc1nerator11111111111111111111111111111111" &&
      recipient !== asset
    );
  return (
    isAddress(recipient) &&
    getAddress(recipient) === recipient &&
    !/^0x0{40}$/i.test(recipient) &&
    !/^0x0{36}dead$/i.test(recipient) &&
    recipient.toLowerCase() !== asset.toLowerCase()
  );
}
export function readProductPaymentRecipients(
  value: unknown,
): ProductPaymentRecipients {
  if (!plainObject(value))
    throw new Error("Payment recipients must be an object.");
  const recipients: Partial<
    Record<ProductRailId, ProductPaymentRecipientConfig>
  > = {};
  for (const [key, row] of Object.entries(value)) {
    if (
      !Object.prototype.hasOwnProperty.call(PRODUCT_RAILS, key) ||
      !plainObject(row)
    )
      throw new Error("Unknown payment rail.");
    const rail = key as ProductRailId,
      { network, symbol } = PRODUCT_RAILS[rail];
    const asset = getProductPaymentAsset(network, symbol);
    if (
      !asset ||
      Object.keys(row).sort().join(",") !== "asset,chain,decimals,recipient" ||
      row.chain !== network ||
      row.decimals !== asset.decimals ||
      typeof row.asset !== "string" ||
      (network === "solana"
        ? row.asset !== asset.address
        : row.asset.toLowerCase() !== asset.address.toLowerCase()) ||
      !validProductRecipient(network, row.recipient, asset.address)
    )
      throw new Error("Payment recipient is invalid.");
    recipients[rail] = {
      recipient: row.recipient,
      asset: asset.address,
      decimals: asset.decimals,
      chain: network,
    };
  }
  return recipients;
}
export function productPaymentRecipient(
  recipients: ProductPaymentRecipients,
  id: ProductRailId,
): ProductPaymentRecipient | undefined {
  const rail = PRODUCT_RAILS[id],
    row = recipients[id];
  if (!rail || !row) return undefined;
  const asset = getProductPaymentAsset(rail.network, rail.symbol);
  if (
    !asset ||
    row.chain !== rail.network ||
    row.decimals !== asset.decimals ||
    (rail.network === "solana"
      ? row.asset !== asset.address
      : row.asset.toLowerCase() !== asset.address.toLowerCase()) ||
    !validProductRecipient(rail.network, row.recipient, asset.address)
  )
    return undefined;
  return {
    ...row,
    kind: rail.network === "solana" ? "solana" : "evm",
    chainId: rail.network,
    symbol: rail.symbol,
  };
}
export type ProductRailRelease = {
  protocolRecipient?: string;
  productOffer?: {
    version?: string;
    payment?: string;
    recipients?: Partial<Record<string, string | null>>;
    checkoutVerified?: boolean;
    rails?: Partial<Record<string, boolean>>;
  };
};
export type ProductRail = {
  id: ProductRailId;
  network: ProductPaymentNetwork;
  symbol: ProductPaymentAssetSymbol;
  recipient: ProductPaymentRecipient | null;
  ready: boolean;
  open: boolean;
};
export function productRail(
  release: ProductRailRelease,
  recipients: ProductPaymentRecipients,
  id: ProductRailId,
): ProductRail {
  const { network, symbol } = PRODUCT_RAILS[id],
    recipient = productPaymentRecipient(recipients, id) ?? null,
    offer = release.productOffer;
  const configured = offer?.recipients?.[id];
  const ready = Boolean(
    recipient &&
    offer?.version === PRODUCT_OFFER_VERSION &&
    offer.payment === "direct-transfer" &&
    typeof configured === "string" &&
    (network === "solana"
      ? configured === recipient.recipient
      : configured.toLowerCase() === recipient.recipient.toLowerCase()),
  );
  return {
    id,
    network,
    symbol,
    recipient,
    ready,
    open:
      ready && offer?.checkoutVerified === true && offer.rails?.[id] === true,
  };
}
export function productRails(
  release: ProductRailRelease,
  recipients: ProductPaymentRecipients,
): ProductRail[] {
  return PRODUCT_RAIL_IDS.map((id) => productRail(release, recipients, id));
}
export function productRailOf(
  network: ProductPaymentNetwork,
  symbol: ProductPaymentAssetSymbol,
): ProductRailId | null {
  return (
    PRODUCT_RAIL_IDS.find(
      (id) =>
        PRODUCT_RAILS[id].network === network &&
        PRODUCT_RAILS[id].symbol === symbol,
    ) ?? null
  );
}
export type ProductTopUpPreview = {
  usdCents: number;
  bonusCents: number;
  balanceBeforeCents: number;
  balanceAfterCents: number;
  calculatedAt: string;
};
export type ProductPaymentStatus =
  | "open"
  | "seen"
  | "credited"
  | "replaced"
  | "expired";
export type StandardPaymentTerms = StandardAiRate & {
  purpose: "period" | "credit";
  expectedPeriod: string | null;
  priceVersion: string;
  workspaceMonthlyCents: number;
  includedAnsweredCases: number;
  additionalAnsweredCaseCents: number;
  includedAiCreditCents: number;
  aiRateCardVersion: string;
};
export type ProductPaymentConfirmation =
  | {
      kind: "evm";
      transactionBlock: string;
      finalizedBlock: string | null;
      remainingBlocks: string | null;
      checkedAt: string;
    }
  | {
      kind: "solana";
      slot: string;
      commitment: "confirmed" | "finalized";
      checkedAt: string;
    };
type IntentBase = {
  preview: ProductTopUpPreview;
  id: string;
  room: string;
  workspace: string;
  offerVersion: typeof PRODUCT_OFFER_VERSION;
  rail: ProductRailId;
  network: ProductPaymentNetwork;
  token: ProductPaymentAssetSymbol;
  recipient: string;
  amountRaw: string;
  usdCents: number;
  createdAt: string;
  expiresAt: string;
  status: ProductPaymentStatus;
  expectedFinalitySeconds: number;
  submittedTx?: string;
  confirmation?: ProductPaymentConfirmation;
  processedTransaction?: { tx: string; outcome: "unmatched" | "credited" };
  nextCheckAt?: number;
  verificationReviewRequired?: boolean;
  checkAgainAt?: number;
  creditedCents?: number;
  orderFormId?: string;
  orderFormRevision?: number;
  settlement?: "manual-usage" | "standard-prepaid";
  standard?: StandardPaymentTerms;
  asset: {
    address: string;
    symbol: ProductPaymentAssetSymbol;
    label: string;
    decimals: 6 | 18;
  };
};
export type EvmProductPaymentIntent = IntentBase & {
  kind: "evm";
  chainId: ChatChainId;
  payer: Address;
};
export type SolanaProductPaymentIntent = IntentBase & {
  kind: "solana";
  chainId: "solana";
  payer: string;
  tokenProgram: typeof PRODUCT_SOLANA_TOKEN_PROGRAM;
  memoProgram: typeof PRODUCT_SOLANA_MEMO_PROGRAM;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  memo: string;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
};
export type ProductPaymentIntent =
  | EvmProductPaymentIntent
  | SolanaProductPaymentIntent;
export type ProductPaymentReceipt = {
  settlement?: "manual-usage" | "standard-prepaid";
  standard?: StandardPaymentTerms & { activatedPeriodId: string | null };
  paymentId: string;
  requestId: string;
  orderFormId?: string;
  orderFormRevision?: number;
  rail: ProductRailId;
  txHash: string;
  kind: "evm" | "solana";
  offerVersion: typeof PRODUCT_OFFER_VERSION;
  network: ProductPaymentNetwork;
  token: ProductPaymentAssetSymbol;
  usdCents: number;
  bonusCents: number;
  amountRaw: string;
  chainId: ProductPaymentNetwork;
  asset: ProductPaymentIntent["asset"];
  recipient: string;
  logIndex?: number;
  instructionIndex?: number;
  paidAt: string;
  creditedAt: string;
  payer: string;
  balanceAfterCents: number;
};
export function productTransferPaymentId(
  network: ProductPaymentNetwork,
  tx: string,
  index: number,
): string {
  return `${network}:${network === "solana" ? tx : tx.toLowerCase()}:${index}`;
}
export function productSolanaPaymentMemo(requestId: string): string {
  return `Templ:${requestId}`;
}
export function productPaymentAmountRaw(
  usdCents: number,
  decimals: number,
): string {
  if (
    !Number.isSafeInteger(usdCents) ||
    usdCents <= 0 ||
    !Number.isSafeInteger(decimals) ||
    decimals < 2 ||
    decimals > 18
  )
    throw new Error("Payment amount is invalid.");
  return (BigInt(usdCents) * 10n ** BigInt(decimals - 2)).toString();
}
