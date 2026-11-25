import { PRODUCT_ANNUAL_PRICES } from "@templ/chat/plans";
import { HttpError } from "./common";

export const STANDARD_ANNUAL_START = "product-standard-annual-start-v1";
const periodId = (time: number) => String(time).padStart(16, "0");

/** Anchor each month independently so a January 31 purchase renews on January 31. */
export function billingMonthBoundary(start: number, months: number) {
  const date = new Date(start);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/** Keep the stored plan pointer compatible and select the allowance in effect at the requested time. */
export async function annualPeriodIdAt(
  storage: { get<T = unknown>(key: string): Promise<T | undefined> },
  currentPeriod: string,
  at: number,
) {
  const start = await storage.get<number>(STANDARD_ANNUAL_START);
  if (start === undefined) return currentPeriod;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isFinite(billingMonthBoundary(start, 12)))
    throw new HttpError(503, "The annual access record is unavailable.");
  const last = PRODUCT_ANNUAL_PRICES.months - 1;
  if (currentPeriod < periodId(start) || currentPeriod > periodId(billingMonthBoundary(start, last)))
    return currentPeriod;
  for (let month = last; month > 0; month--) {
    const boundary = billingMonthBoundary(start, month);
    if (boundary <= at) return periodId(boundary);
  }
  return periodId(start);
}
