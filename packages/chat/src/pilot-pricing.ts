import { PRODUCT_PILOT_DEFAULTS } from "./plans";

export type PilotOrderFormTerms = {
  title: string;
  durationDays: number;
  monthlyCapCents: number;
  totalCapCents: number;
  upfrontCents: number;
};

export type PilotCapReason = "monthly cap" | "pilot cap";

/** Payment requests use whole dollars and cover the remaining upfront cents. */
export function pilotUpfrontRequestCents(
  upfrontCents: number,
  paidCents: number,
): number {
  if (
    ![upfrontCents, paidCents].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("Pilot amounts must use whole cents.");
  const requestedCents =
    Math.ceil(Math.max(0, upfrontCents - paidCents) / 100) * 100;
  if (!Number.isSafeInteger(requestedCents))
    throw new Error("Pilot amounts must use whole cents.");
  return requestedCents;
}

/** Cap room uses integer cents. A crossing case pays only the room left. */
export function pilotChargeCents(
  priceCents: number,
  caps: Pick<PilotOrderFormTerms, "monthlyCapCents" | "totalCapCents">,
  usage: { monthUsedCents: number; totalUsedCents: number },
): { priceCents: number; reason: PilotCapReason | null } {
  if (
    ![
      priceCents,
      caps.monthlyCapCents,
      caps.totalCapCents,
      usage.monthUsedCents,
      usage.totalUsedCents,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    throw new Error("Pilot amounts must use whole cents.");
  const monthRoom = Math.max(0, caps.monthlyCapCents - usage.monthUsedCents);
  const totalRoom = Math.max(0, caps.totalCapCents - usage.totalUsedCents);
  const capped = Math.min(priceCents, monthRoom, totalRoom);
  return {
    priceCents: capped,
    reason:
      capped === priceCents
        ? null
        : totalRoom <= monthRoom
          ? "pilot cap"
          : "monthly cap",
  };
}

export function isPilotOrderFormTerms(
  value: unknown,
): value is PilotOrderFormTerms {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const terms = value as Record<string, unknown>;
  const cents = (amount: unknown): amount is number =>
    Number.isSafeInteger(amount) &&
    Number(amount) > 0 &&
    Number(amount) <= PRODUCT_PILOT_DEFAULTS.maxCapCents &&
    Number(amount) % 100 === 0;
  return (
    Object.keys(terms).sort().join() ===
      "durationDays,monthlyCapCents,title,totalCapCents,upfrontCents" &&
    typeof terms.title === "string" &&
    terms.title === terms.title.trim() &&
    terms.title.length > 0 &&
    terms.title.length <= 80 &&
    !/[\u0000-\u001f\u007f\u00b7]/.test(terms.title) &&
    Number.isSafeInteger(terms.durationDays) &&
    Number(terms.durationDays) > 0 &&
    Number(terms.durationDays) <= PRODUCT_PILOT_DEFAULTS.maxDurationDays &&
    cents(terms.monthlyCapCents) &&
    cents(terms.totalCapCents) &&
    cents(terms.upfrontCents) &&
    terms.monthlyCapCents <= terms.totalCapCents &&
    terms.upfrontCents <= terms.totalCapCents
  );
}
