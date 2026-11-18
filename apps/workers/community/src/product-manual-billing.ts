/** Manual receivables are neither prepaid funds nor payment receipts.
 * Mutations run in the room transaction with the case change. */
import {
  productPriceSource,
  type ProductDisputeReason,
} from "@templ/chat/product-catalog";
import {
  resolutionMonth,
  type ResolutionPriceTable,
} from "@templ/chat/resolution-pricing";
import { HttpError } from "./common";
import { activeOrderForm, readProductOrderForms } from "./product-order-forms";
import type { ProductState, ProductStorage } from "./product-entitlements";

export const MANUAL_TOTALS_KEY = "product-manual-totals-v1";
export const MANUAL_ROW_PREFIX = "product-manual-row-v1:";
const PENDING_PREFIX = "product-manual-pending-v1:";
export const MANUAL_AGREEMENT_PREFIX = "product-manual-agreement-v1:";
const MONTH_PREFIX = "product-manual-month-v1:";
export type ManualAgreement = {
  id: string;
  revision: number;
  documentSha256: string;
  authorizedAt: number;
  effectiveRevision: number;
  effectiveDocumentSha256: string;
};
export type ManualTotals = {
  schema: 1;
  pendingCents: number;
  chargedCents: number;
  creditedCents: number;
  dueCents: number;
};
export type ManualRow = {
  kind: "charge" | "credit";
  ref: string;
  at: number;
  cents: number;
  agreement: ManualAgreement;
  priceVersion: string;
  table: ResolutionPriceTable;
  reason?: ProductDisputeReason;
};
type Reader = Pick<ProductStorage, "get">;
const fail = () => new HttpError(503, "Manual billing could not be checked.");
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const sameTable = (left: ResolutionPriceTable, right: ResolutionPriceTable) =>
  left.usdCents === right.usdCents &&
  left.aiOnlyUsdCents === right.aiOnlyUsdCents &&
  left.stepOneAfterCases === right.stepOneAfterCases &&
  left.stepOneUsdCents === right.stepOneUsdCents;

/** The current agreement authorizes the effective table, including an older
 * revision while an amendment's notice period runs. */
export async function manualAgreement(
  storage: Reader,
  state: ProductState,
): Promise<ManualAgreement | null> {
  const forms = await readProductOrderForms(storage);
  const active = activeOrderForm(forms, state.asOf);
  const source = productPriceSource(state.priceVersion);
  if (
    !active ||
    active.service !== "software" ||
    active.pilot ||
    active.usage ||
    source?.kind !== "order-form" ||
    source.id !== active.id
  )
    return null;
  const effective = forms.history.find(
    (form) => form.id === source.id && form.revision === source.revision,
  );
  if (
    !effective ||
    effective.service !== "software" ||
    effective.pilot ||
    effective.revision > active.revision ||
    !sameTable(effective.table, state.prices.table)
  )
    return null;
  return {
    id: active.id,
    revision: active.revision,
    documentSha256: active.documentSha256,
    authorizedAt: state.asOf,
    effectiveRevision: effective.revision,
    effectiveDocumentSha256: effective.documentSha256,
  };
}

/** A captured agreement remains the authority after amendment or expiry. */
export async function checkManualAgreement(
  storage: Reader,
  agreement: ManualAgreement,
  priceVersion: string,
  table: ResolutionPriceTable,
) {
  if (!agreement || !natural(agreement.authorizedAt)) throw fail();
  const forms = await readProductOrderForms(storage);
  const active = forms.history.find(
    (form) => form.id === agreement.id && form.revision === agreement.revision,
  );
  const source = productPriceSource(priceVersion);
  const effective = forms.history.find(
    (form) =>
      form.id === agreement.id && form.revision === agreement.effectiveRevision,
  );
  if (
    !active ||
    active.id !== agreement.id ||
    active.revision !== agreement.revision ||
    active.startsAt > agreement.authorizedAt ||
    active.endsAt <= agreement.authorizedAt ||
    (forms.ended[active.id] !== undefined &&
      forms.ended[active.id] <= agreement.authorizedAt) ||
    active.documentSha256 !== agreement.documentSha256 ||
    active.service !== "software" ||
    active.pilot ||
    source?.kind !== "order-form" ||
    source.id !== agreement.id ||
    source.revision !== agreement.effectiveRevision ||
    !effective ||
    effective.service !== "software" ||
    effective.pilot ||
    effective.revision > active.revision ||
    effective.documentSha256 !== agreement.effectiveDocumentSha256 ||
    !sameTable(effective.table, table)
  )
    throw fail();
}

export async function manualTotals(storage: Reader): Promise<ManualTotals> {
  const value = await storage.get<ManualTotals>(MANUAL_TOTALS_KEY);
  if (value === undefined)
    return {
      schema: 1,
      pendingCents: 0,
      chargedCents: 0,
      creditedCents: 0,
      dueCents: 0,
    };
  if (
    value.schema !== 1 ||
    ![
      value.pendingCents,
      value.chargedCents,
      value.creditedCents,
      value.dueCents,
    ].every(natural) ||
    value.chargedCents - value.creditedCents !== value.dueCents
  )
    throw fail();
  return value;
}

/** Updating the same pending case replaces its estimate, rather than adding it. */
export async function reserveManualEstimate(
  storage: ProductStorage,
  ref: string,
  cents: number,
) {
  if (!natural(cents)) throw fail();
  const before = (await storage.get<number>(`${PENDING_PREFIX}${ref}`)) ?? 0;
  if (!natural(before)) throw fail();
  if (before === cents) return;
  const totals = await manualTotals(storage);
  totals.pendingCents += cents - before;
  if (!natural(totals.pendingCents)) throw fail();
  await storage.put(`${PENDING_PREFIX}${ref}`, cents);
  await storage.put(MANUAL_TOTALS_KEY, totals);
}

/** Removed support history cannot keep a pending, unearned estimate. */
export async function reconcileManualEstimates(
  storage: ProductStorage & Pick<DurableObjectTransaction, "list">,
  pending: ReadonlyMap<string, number>,
) {
  const rows = await storage.list<number>({
    prefix: PENDING_PREFIX,
    limit: 2001,
  });
  if (rows.size > 2000)
    throw new HttpError(
      409,
      "This workspace is too large for one recovery run.",
    );
  for (const [key, cents] of rows) {
    const ref = key.slice(PENDING_PREFIX.length);
    if (!/^[0-9a-f]{16}$/.test(ref) || !natural(cents)) throw fail();
    await reserveManualEstimate(storage, ref, pending.get(ref) ?? 0);
  }
}

/** A dispute reverses its own receivable once. This is not a payment. */
export async function recordManualRow(storage: ProductStorage, row: ManualRow) {
  if (
    !natural(row.at) ||
    !natural(row.cents) ||
    !/^[0-9a-f]{16}$/.test(row.ref)
  )
    throw fail();
  await checkManualAgreement(
    storage,
    row.agreement,
    row.priceVersion,
    row.table,
  );
  const key = `${MANUAL_ROW_PREFIX}${row.kind}:${row.ref}`;
  const previous = await storage.get<ManualRow>(key);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(row)) throw fail();
    return;
  }
  if (row.kind === "credit") {
    const debit = await storage.get<ManualRow>(
      `${MANUAL_ROW_PREFIX}charge:${row.ref}`,
    );
    if (
      !debit ||
      debit.cents !== row.cents ||
      debit.priceVersion !== row.priceVersion ||
      !row.reason ||
      JSON.stringify(debit.agreement) !== JSON.stringify(row.agreement)
    )
      throw fail();
  }
  const totals = await manualTotals(storage);
  if (row.kind === "charge") totals.chargedCents += row.cents;
  else totals.creditedCents += row.cents;
  totals.dueCents = totals.chargedCents - totals.creditedCents;
  if (
    ![totals.chargedCents, totals.creditedCents, totals.dueCents].every(natural)
  )
    throw fail();
  const agreementKey = `${MANUAL_AGREEMENT_PREFIX}${row.agreement.id}:${row.agreement.revision}:${row.agreement.effectiveRevision}`;
  const account = (await storage.get<{
    agreement: ManualAgreement;
    table: ResolutionPriceTable;
    chargedCents: number;
    creditedCents: number;
  }>(agreementKey)) ?? {
    agreement: row.agreement,
    table: row.table,
    chargedCents: 0,
    creditedCents: 0,
  };
  if (
    !sameTable(account.table, row.table) ||
    !natural(account.chargedCents) ||
    !natural(account.creditedCents) ||
    (
      [
        "id",
        "revision",
        "documentSha256",
        "effectiveRevision",
        "effectiveDocumentSha256",
      ] as const
    ).some((key) => account.agreement[key] !== row.agreement[key])
  )
    throw fail();
  if (row.kind === "charge") account.chargedCents += row.cents;
  else account.creditedCents += row.cents;
  await storage.put(agreementKey, account);
  const posted = await manualPostedMonth(storage, row.at);
  if (row.kind === "charge") {
    posted.cases++;
    posted.chargedCents += row.cents;
  } else posted.creditedCents += row.cents;
  await storage.put(`product-manual-posted-v1:${posted.id}`, posted);
  await storage.put(key, row);
  await storage.put(
    `${MONTH_PREFIX}${resolutionMonth(row.at)}:${row.kind}:${row.ref}`,
    row,
  );
  await storage.put(MANUAL_TOTALS_KEY, totals);
}

export async function manualStatement(
  storage: Reader & Pick<DurableObjectTransaction, "list">,
  month: string,
) {
  const rows = await storage.list<ManualRow>({
    prefix: `${MONTH_PREFIX}${month}:`,
    limit: 5001,
  });
  const before = await storage.list<{ closingCents: number }>({
    prefix: "product-manual-closing-v1:",
    end: `product-manual-closing-v1:${month}`,
    reverse: true,
    limit: 1,
  });
  const openingCents = [...before.values()][0]?.closingCents ?? 0;
  const closing = await storage.get<{ closingCents: number }>(
    `product-manual-closing-v1:${month}`,
  );
  return {
    openingCents,
    closingCents: closing?.closingCents ?? openingCents,
    rows: [...rows.values()].slice(0, 5000),
    truncated: rows.size > 5000,
  };
}

export async function noteManualClosing(storage: ProductStorage, at: number) {
  await storage.put(`product-manual-closing-v1:${resolutionMonth(at)}`, {
    closingCents: (await manualTotals(storage)).dueCents,
  });
}

/** Match charge-detail retention; agreement totals and month closings remain. */
export async function pruneManualRows(
  storage: ProductStorage & Pick<DurableObjectTransaction, "list" | "delete">,
  cutoffMonth: string,
) {
  for (let batch = 0; batch < 4; batch++) {
    const rows = await storage.list<ManualRow>({
      prefix: MONTH_PREFIX,
      end: `${MONTH_PREFIX}${cutoffMonth}`,
      limit: 128,
    });
    if (!rows.size) break;
    await storage.delete([...rows.keys()]);
  }
}

export async function manualDeletionSummary(
  storage: Reader & Pick<DurableObjectTransaction, "list">,
) {
  return {
    ...(await manualTotals(storage)),
    agreements: [
      ...(await storage.list({ prefix: MANUAL_AGREEMENT_PREFIX })).values(),
    ],
    months: [
      ...(await storage.list({ prefix: "product-manual-posted-v1:" })).values(),
    ],
  };
}

/** Called only after the case ledger applies its open-dispute retention checks. */
export async function forgetManualCase(
  storage: Pick<DurableObjectTransaction, "delete">,
  ref: string,
) {
  await storage.delete([
    `${MANUAL_ROW_PREFIX}charge:${ref}`,
    `${MANUAL_ROW_PREFIX}credit:${ref}`,
    `${PENDING_PREFIX}${ref}`,
  ]);
}

/** Statements post when the alarm runs; the captured final clock still sets the price step. */
export async function manualPostedMonth(storage: Reader, at: number) {
  const id = resolutionMonth(at);
  const value = await storage.get<{
    id: string;
    cases: number;
    chargedCents: number;
    creditedCents: number;
  }>(`product-manual-posted-v1:${id}`);
  if (!value) return { id, cases: 0, chargedCents: 0, creditedCents: 0 };
  if (
    value.id !== id ||
    ![value.cases, value.chargedCents, value.creditedCents].every(natural)
  )
    throw fail();
  return value;
}
