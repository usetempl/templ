import { PRODUCT_BRAIN_STORAGE_PRICE } from "./plans";
import type { BrainStoragePrice } from "./knowledge";
export type { BrainStoragePrice, BrainStorageView } from "./knowledge";

export const BRAIN_STORAGE_PRICE = PRODUCT_BRAIN_STORAGE_PRICE;

export function brainStorageTerms(
  price: BrainStoragePrice = BRAIN_STORAGE_PRICE,
): string {
  return [
    `Storage price ${price.version}.`,
    `${price.freeBytesPerWorkspace} bytes of retained imported UTF-8 chunk text are free per workspace.`,
    `Additional text costs ${price.usdCentsPerGbMonth} USD cents per ${price.bytesPerGb} bytes per UTC calendar month.`,
    "Usage is prorated by milliseconds in each UTC calendar month.",
    "Monthly totals round to the nearest cent, with half cents rounded up.",
    "Saved links, FAQs and saved replies are excluded.",
    "Source labels, indexes and provider metadata are excluded.",
    "Viewing this price creates no debt or payment authorization.",
    "Collection requires separately signed storage terms and qualified production billing.",
    "Existing agreements keep their recorded prices and debt limits.",
  ].join("\n");
}

/** Cents for one complete monthly integral. Retried checkpoints never round separately. */
export function brainStorageEstimateCents(
  billableByteMs: string,
  monthMs: number,
  price: BrainStoragePrice = BRAIN_STORAGE_PRICE,
): number {
  if (
    !/^(0|[1-9][0-9]*)$/.test(billableByteMs) ||
    !Number.isSafeInteger(monthMs) ||
    monthMs <= 0 ||
    !Number.isSafeInteger(price.bytesPerGb) ||
    price.bytesPerGb <= 0 ||
    !Number.isSafeInteger(price.usdCentsPerGbMonth) ||
    price.usdCentsPerGbMonth < 0
  )
    throw new Error("Invalid storage estimate.");
  const divisor = BigInt(price.bytesPerGb) * BigInt(monthMs);
  const cents =
    (BigInt(billableByteMs) * BigInt(price.usdCentsPerGbMonth) + divisor / 2n) /
    divisor;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Storage estimate is too large.");
  return Number(cents);
}

export function brainStorageBillingTerms(): string {
  return [
    `Storage rate ${BRAIN_STORAGE_PRICE.version}.`,
    `${BRAIN_STORAGE_PRICE.freeBytesPerWorkspace} retained imported UTF-8 chunk bytes are free per workspace.`,
    `Additional text costs ${BRAIN_STORAGE_PRICE.usdCentsPerGbMonth} USD cents per ${BRAIN_STORAGE_PRICE.bytesPerGb} bytes per UTC calendar month.`,
    "Usage is prorated by milliseconds in each UTC calendar month.",
    "Monthly totals round to the nearest cent, with half cents rounded up.",
    "Saved links, FAQs, saved replies, source labels, indexes and provider metadata are excluded.",
    "This separate signed agreement authorizes only its recorded storage rate and workspace.",
    "Storage, usage fees, unpaid case fees and reserved usage share the workspace agreement debt limit.",
  ].join("\n");
}
