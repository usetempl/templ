import type { ProductPilotView } from "@templ/chat/product-catalog";
import { pilotChargeCents } from "@templ/chat/pilot-pricing";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { HttpError } from "./common";
import {
  PRODUCT_TOP_UPS_KEY,
  readTopUps,
  type ProductStorage,
} from "./product-entitlements";
import {
  activeOrderForm,
  pilotUpfrontCreditCents,
  readProductOrderForms,
  type ProductOrderForm,
  type ProductOrderForms,
  type PilotOrderFormActivation,
} from "./product-order-forms";

export const PILOT_USAGE_PREFIX = "product-pilot-usage-v1:";
type Reader = Pick<ProductStorage, "get">;
type PilotUsage = {
  schema: 1;
  months: Record<string, number>;
  totalUsedCents: number;
  upfrontUsedCents: number;
};
export type PilotCharge = {
  id: string;
  title: string;
  revision: number;
  upfrontCreditCents: number;
  /** Receipt draws stay in the room so a disputed charge restores its credit. */
  upfrontDraws: { paymentId: string; cents: number }[];
};
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
export function isPilotCharge(value: unknown): value is PilotCharge {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as PilotCharge;
  return (
    /^OF-\d{4}-\d{3}$/.test(row.id) &&
    typeof row.title === "string" &&
    row.title.length > 0 &&
    row.title.length <= 80 &&
    natural(row.revision) &&
    row.revision > 0 &&
    natural(row.upfrontCreditCents) &&
    Array.isArray(row.upfrontDraws) &&
    row.upfrontDraws.every(
      (draw) =>
        draw &&
        typeof draw.paymentId === "string" &&
        natural(draw.cents) &&
        draw.cents > 0,
    ) &&
    new Set(row.upfrontDraws.map((draw) => draw.paymentId)).size ===
      row.upfrontDraws.length &&
    row.upfrontDraws.reduce((sum, draw) => sum + draw.cents, 0) ===
      row.upfrontCreditCents
  );
}
async function readUsage(storage: Reader, id: string): Promise<PilotUsage> {
  const saved = await storage.get<PilotUsage>(`${PILOT_USAGE_PREFIX}${id}`);
  if (saved === undefined)
    return { schema: 1, months: {}, totalUsedCents: 0, upfrontUsedCents: 0 };
  if (
    saved?.schema !== 1 ||
    !natural(saved.totalUsedCents) ||
    !natural(saved.upfrontUsedCents) ||
    !saved.months ||
    typeof saved.months !== "object" ||
    Array.isArray(saved.months) ||
    !Object.entries(saved.months).every(
      ([month, cents]) =>
        /^\d{4}(0[1-9]|1[0-2])$/.test(month) && natural(cents),
    ) ||
    Object.values(saved.months).reduce((sum, cents) => sum + cents, 0) !==
      saved.totalUsedCents ||
    saved.upfrontUsedCents > saved.totalUsedCents
  )
    throw new HttpError(503, "The pilot balance could not be checked.");
  return saved;
}

/** Accepted pilot terms keep protecting charges after a testing flag ends. */
export async function pilotChargeAt(
  storage: Reader,
  at: number,
  priceCents: number,
) {
  const forms = await readProductOrderForms(storage);
  const form = activeOrderForm(forms, at);
  if (!form?.pilot) return null;
  const activation = forms.activations?.[`${form.id}:${form.revision}`];
  if (!activation)
    throw new HttpError(503, "The pilot payment could not be checked.");
  const usage = await readUsage(storage, form.id);
  return {
    form,
    activation,
    ...pilotChargeCents(priceCents, form.pilot, {
      monthUsedCents: usage.months[resolutionMonth(at)] ?? 0,
      totalUsedCents: usage.totalUsedCents,
    }),
  };
}

async function upfrontRoom(
  storage: Reader,
  form: ProductOrderForm,
  used: number,
  activation?: PilotOrderFormActivation,
) {
  const ids = new Set(activation?.paymentIds ?? []);
  const ledger = await readTopUps(storage);
  const rows = ledger.topUps.filter((row) => ids.has(row.id));
  const available = rows.reduce((sum, row) => sum + row.paidLeft, 0);
  return {
    ledger,
    rows,
    availableCents: Math.min(
      Math.max(0, (form.pilot?.upfrontCents ?? 0) - used),
      available,
    ),
  };
}

/** Called once for a final billable case, in the charge's transaction. */
export async function settlePilotCharge(
  storage: ProductStorage,
  form: ProductOrderForm,
  month: string,
  cents: number,
  activation: PilotOrderFormActivation,
): Promise<PilotCharge> {
  if (!form.pilot)
    throw new HttpError(503, "The pilot terms could not be checked.");
  const usage = await readUsage(storage, form.id);
  const room = await upfrontRoom(
    storage,
    form,
    usage.upfrontUsedCents,
    activation,
  );
  let left = Math.min(cents, room.availableCents);
  const upfrontCreditCents = left;
  const upfrontDraws: PilotCharge["upfrontDraws"] = [];
  for (const row of room.rows) {
    const drawn = Math.min(left, row.paidLeft);
    if (!drawn) continue;
    row.paidLeft -= drawn;
    left -= drawn;
    upfrontDraws.push({ paymentId: row.id, cents: drawn });
    if (!left) break;
  }
  if (upfrontCreditCents) await storage.put(PRODUCT_TOP_UPS_KEY, room.ledger);
  usage.months[month] = (usage.months[month] ?? 0) + cents;
  usage.totalUsedCents += cents;
  usage.upfrontUsedCents += upfrontCreditCents;
  await storage.put(`${PILOT_USAGE_PREFIX}${form.id}`, usage);
  return {
    id: form.id,
    title: form.pilot.title,
    revision: form.revision,
    upfrontCreditCents,
    upfrontDraws,
  };
}

/** Accepted disputes restore room in the charge's original UTC month. */
export async function creditPilotCharge(
  storage: ProductStorage,
  pilot: PilotCharge,
  month: string,
  cents: number,
) {
  const usage = await readUsage(storage, pilot.id);
  if (
    (usage.months[month] ?? 0) < cents ||
    usage.upfrontUsedCents < pilot.upfrontCreditCents
  )
    throw new HttpError(503, "The pilot balance could not be checked.");
  usage.months[month] -= cents;
  usage.totalUsedCents -= cents;
  usage.upfrontUsedCents -= pilot.upfrontCreditCents;
  const ledger = await readTopUps(storage);
  for (const draw of pilot.upfrontDraws) {
    const row = ledger.topUps.find((item) => item.id === draw.paymentId);
    if (!row || row.paidLeft + draw.cents > row.paidCents)
      throw new HttpError(503, "The pilot credit could not be checked.");
    row.paidLeft += draw.cents;
  }
  await storage.put(PRODUCT_TOP_UPS_KEY, ledger);
  await storage.put(`${PILOT_USAGE_PREFIX}${pilot.id}`, usage);
}

export async function readProductPilotView(
  storage: Reader,
  now: number,
): Promise<ProductPilotView | null> {
  const forms = await readProductOrderForms(storage);
  const current = activeOrderForm(forms, now);
  const form = current?.pilot
    ? current
    : [...forms.history].reverse().find((item) => item.pilot);
  return form ? pilotView(storage, forms, form, now) : null;
}

/** A signed revision awaiting its payment is separate from the current caps. */
export async function readProductPendingPilotView(
  storage: Reader,
  now: number,
): Promise<ProductPilotView | null> {
  const forms = await readProductOrderForms(storage);
  const current = activeOrderForm(forms, now);
  const latest = [...forms.history].reverse().find((item) => item.pilot);
  return current?.pilot &&
    latest &&
    (current.id !== latest.id || current.revision !== latest.revision) &&
    latest.endsAt > now &&
    (forms.ended[latest.id] ?? Infinity) > now
    ? pilotView(storage, forms, latest, now)
    : null;
}

async function pilotView(
  storage: Reader,
  forms: ProductOrderForms,
  form: ProductOrderForm,
  now: number,
): Promise<ProductPilotView | null> {
  if (!form?.pilot) return null;
  const activation = forms.activations?.[`${form.id}:${form.revision}`];
  const usage = await readUsage(storage, form.id);
  const room = await upfrontRoom(
    storage,
    form,
    usage.upfrontUsedCents,
    activation,
  );
  const evidence = await pilotUpfrontCreditCents(storage, form);
  const ended = form.endsAt <= now || (forms.ended[form.id] ?? Infinity) <= now;
  return {
    id: form.id,
    title: form.pilot.title,
    revision: form.revision,
    startsAt: new Date(form.startsAt).toISOString(),
    endsAt: new Date(form.endsAt).toISOString(),
    state: ended
      ? "ended"
      : !activation
        ? "awaiting-payment"
        : form.startsAt > now
          ? "scheduled"
          : "active",
    month: resolutionMonth(now),
    monthlyCapCents: form.pilot.monthlyCapCents,
    monthUsedCents: usage.months[resolutionMonth(now)] ?? 0,
    totalCapCents: form.pilot.totalCapCents,
    totalUsedCents: usage.totalUsedCents,
    upfrontCents: form.pilot.upfrontCents,
    upfrontPaidCents: evidence.paidCents,
    upfrontCreditLeftCents: activation
      ? room.availableCents
      : Math.min(form.pilot.upfrontCents, evidence.availableCents),
  };
}
