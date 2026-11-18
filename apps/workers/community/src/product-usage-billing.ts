import { checkpointStorageDue, storageCapacityDebt, type StorageBillingEnv } from "./brain-storage-billing";
import {
  isProductUsageTerms,
  usageFeatureCents,
  usageCaseReserveCents,
  type ProductUsageFeature,
  type ProductUsageTerms,
  type ProductUsageTotals,
  type ProductUsageView,
  type ProductUsageRow,
  type ProductUsageStatement,
} from "@templ/chat/usage-billing";
import {
  PRODUCT_DISPUTE_REASONS,
  PRODUCT_DISPUTE_TEXT_MAX,
  type ProductDisputeReason,
  type ProductChargeCloser,
  type ProductChargeResolvedBy,
} from "@templ/chat/product-catalog";
import { PRODUCT_RESOLUTION_RULES } from "@templ/chat/plans";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { SupportCase } from "@templ/chat/support";
import { HttpError } from "./common";
import {
  activeProductOrderForm,
  readProductOrderForms,
  type ProductOrderForm,
} from "./product-order-forms";
import type { ProductStorage } from "./product-entitlements";
import {
  featureOn,
  usageAiResolutionBillingOn,
  type WorkspaceFlagEnv,
} from "./workspace-flags";
import { wakeRoomAt } from "./room-alarm";
import {
  takeAutomaticDisputeCredit,
  finalChargeResolution,
} from "./product-charges";

export const USAGE_ACCESS_KEY = "product-usage-access-v1";
export const USAGE_TOTALS_KEY = "product-usage-totals-v1";
const CASE_PREFIX = "product-usage-case-v1:";
const ROW_PREFIX = "product-usage-row-v1:";
const MONTH_PREFIX = "product-usage-month-v1:";
const CASE_ROW_PREFIX = "product-usage-case-row-v1:";
const DISPUTE_PREFIX = "product-usage-dispute-v1:";
const DUE_PREFIX = "product-usage-due-v1:";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const SHA256 = /^[0-9a-f]{64}$/;
const REF = /^[0-9a-f]{16}$/;
const FORM = /^OF-\d{4}-\d{3}$/;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fail = () => new HttpError(503, "Usage billing could not be checked.");
const pad = (value: number) => String(value).padStart(16, "0");
type Reader = Pick<ProductStorage, "get">;
type Storage = ProductStorage &
  Pick<DurableObjectTransaction, "list" | "delete" | "getAlarm" | "setAlarm">;
type Agreement = {
  id: string;
  revision: number;
  documentSha256: string;
  startsAt: number;
  endsAt: number;
  terms: ProductUsageTerms;
};
type Access = {
  schema: 1;
  formId: string;
  revision: number;
  documentSha256: string;
  at: number;
  operator: ChatPrincipalId;
  approvedBy: ChatPrincipalId;
  authenticatedAt: number;
  reason: string;
  enabled: boolean;
};
type Totals = {
  schema: 1;
  chargedCents: number;
  disputedCents: number;
  paidCents: number;
  forgivenCents: number;
  reservedCents: number;
};
type UsageCase = {
  schema: 1;
  ref: string;
  openedAt: number;
  agreement: Agreement;
  features: Partial<Record<ProductUsageFeature, number>>;
  chargedCents: number;
  reservedCents: number;
  templAnsweredAt: number | null;
  humanReplied: boolean;
  finalAt: number | null;
  excludedAt: number | null;
  dueAt: number | null;
  resolutionDueAt: number | null;
};

const keys = (
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
function checkedAccess(value: unknown): Access | null {
  if (value === undefined) return null;
  if (
    !object(value) ||
    !keys(value, [
      "schema",
      "formId",
      "revision",
      "documentSha256",
      "at",
      "operator",
      "approvedBy",
      "authenticatedAt",
      "reason",
      "enabled",
    ]) ||
    value.schema !== 1 ||
    !FORM.test(String(value.formId)) ||
    !natural(value.revision) ||
    value.revision === 0 ||
    !SHA256.test(String(value.documentSha256)) ||
    !natural(value.at) ||
    !natural(value.authenticatedAt) ||
    value.authenticatedAt > value.at ||
    normalizeChatPrincipal(value.operator) !== value.operator ||
    normalizeChatPrincipal(value.approvedBy) !== value.approvedBy ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 3 ||
    value.reason.length > 280 ||
    typeof value.enabled !== "boolean"
  )
    throw fail();
  return value as Access;
}
function agreementOf(form: ProductOrderForm): Agreement | null {
  if (
    form.service !== "software" ||
    form.pilot ||
    !form.usage ||
    !isProductUsageTerms(form.usage)
  )
    return null;
  return {
    id: form.id,
    revision: form.revision,
    documentSha256: form.documentSha256,
    startsAt: form.startsAt,
    endsAt: form.endsAt,
    terms: structuredClone(form.usage),
  };
}
export async function activeUsageAgreement(
  storage: Reader,
  now: number,
  env: WorkspaceFlagEnv = {},
): Promise<Agreement | null> {
  if (!(await featureOn(env, storage, "manualBilling"))) return null;
  const form = await activeProductOrderForm(storage, now);
  const agreement = form ? agreementOf(form) : null;
  const access = checkedAccess(await storage.get(USAGE_ACCESS_KEY));
  return agreement &&
    access?.enabled &&
    access.at <= now &&
    access.formId === agreement.id &&
    access.revision === agreement.revision &&
    access.documentSha256 === agreement.documentSha256
    ? agreement
    : null;
}
export async function usagePaymentAgreement(
  storage: Reader,
  now: number,
  env: WorkspaceFlagEnv = {},
): Promise<Agreement | null> {
  const active = await activeUsageAgreement(storage, now, env);
  if (active) return active;
  if (!(await featureOn(env, storage, "manualBilling"))) return null;
  const totals = await usageTotals(storage);
  if (totals.dueCents === 0 && totals.reservedCents === 0) return null;
  const forms = await readProductOrderForms(storage);
  const form = [...forms.history]
    .reverse()
    .find((item) => item.usage && item.startsAt <= now);
  return form ? agreementOf(form) : null;
}
async function checkedCapturedAgreement(storage: Reader, agreement: Agreement) {
  const forms = await readProductOrderForms(storage);
  const form = forms.history.find(
    (item) => item.id === agreement.id && item.revision === agreement.revision,
  );
  if (!form || JSON.stringify(agreementOf(form)) !== JSON.stringify(agreement))
    throw fail();
}
export async function usageTotals(
  storage: Reader,
): Promise<ProductUsageTotals> {
  const value = await storage.get<Totals>(USAGE_TOTALS_KEY);
  const totals = value ?? {
    schema: 1,
    chargedCents: 0,
    disputedCents: 0,
    paidCents: 0,
    forgivenCents: 0,
    reservedCents: 0,
  };
  if (
    !object(totals) ||
    !keys(totals, [
      "schema",
      "chargedCents",
      "disputedCents",
      "paidCents",
      "forgivenCents",
      "reservedCents",
    ]) ||
    totals.schema !== 1 ||
    ![
      totals.chargedCents,
      totals.disputedCents,
      totals.paidCents,
      totals.forgivenCents,
      totals.reservedCents,
    ].every(natural)
  )
    throw fail();
  if (
    totals.disputedCents > totals.chargedCents ||
    totals.forgivenCents > totals.chargedCents - totals.disputedCents ||
    !Number.isSafeInteger(
      totals.chargedCents -
        totals.disputedCents -
        totals.forgivenCents -
        totals.paidCents,
    )
  )
    throw fail();
  const balance =
    totals.chargedCents -
    totals.disputedCents -
    totals.forgivenCents -
    totals.paidCents;
  return {
    chargedCents: totals.chargedCents,
    disputedCents: totals.disputedCents,
    paidCents: totals.paidCents,
    forgivenCents: totals.forgivenCents,
    reservedCents: totals.reservedCents,
    dueCents: Math.max(0, balance),
    creditCents: Math.max(0, -balance),
  };
}
async function saveTotals(storage: ProductStorage, totals: ProductUsageTotals) {
  if (
    ![
      totals.chargedCents,
      totals.disputedCents,
      totals.paidCents,
      totals.forgivenCents,
      totals.reservedCents,
    ].every(natural) ||
    totals.disputedCents > totals.chargedCents ||
    totals.forgivenCents > totals.chargedCents - totals.disputedCents
  )
    throw fail();
  const { dueCents: _, creditCents: __, ...record } = totals;
  await storage.put(USAGE_TOTALS_KEY, { schema: 1, ...record });
}
function availableDisputeCredit(totals: ProductUsageTotals, cents: number) {
  return Math.min(
    cents,
    totals.chargedCents - totals.disputedCents - totals.forgivenCents,
  );
}
export async function usageView(
  storage: Reader,
  now: number,
  env: WorkspaceFlagEnv = {},
): Promise<ProductUsageView> {
  const totals = await usageTotals(storage);
  const form = await activeProductOrderForm(storage, now);
  const agreement = form ? agreementOf(form) : null;
  const on = await featureOn(env, storage, "manualBilling");
  const active = on ? await activeUsageAgreement(storage, now, env) : null;
  const terms = active?.terms ?? agreement?.terms ?? null;
  const storageDebtCents = await storageCapacityDebt(storage);
  const availableCreditCents = terms
    ? Math.max(
        0,
        terms.debtLimitCents -
          totals.dueCents -
          storageDebtCents +
          totals.creditCents -
          totals.reservedCents,
      )
    : 0;
  return {
    ...totals,
    status: !on
      ? "off"
      : !agreement
        ? "agreement-needed"
        : !active
          ? "approval-needed"
          : availableCreditCents < usageCaseReserveCents(active.terms)
            ? "credit-limit"
            : "active",
    debtLimitCents: terms?.debtLimitCents ?? 0,
    availableCreditCents,
    agreement: agreement
      ? {
          id: agreement.id,
          revision: agreement.revision,
          endsAt: new Date(agreement.endsAt).toISOString(),
        }
      : null,
    terms,
  };
}
export async function approveUsageAccess(
  storage: ProductStorage,
  input: Omit<Access, "schema" | "documentSha256" | "at"> & { now: number },
) {
  const form = await activeProductOrderForm(storage, input.now);
  if (
    !form?.usage ||
    form.service !== "software" ||
    form.pilot ||
    form.id !== input.formId ||
    form.revision !== input.revision ||
    form.approvedBy !== input.approvedBy
  )
    throw new HttpError(409, "Read the signed usage agreement and try again.");
  const record: Access = {
    schema: 1,
    formId: form.id,
    revision: form.revision,
    documentSha256: form.documentSha256,
    at: input.now,
    operator: input.operator,
    approvedBy: input.approvedBy,
    authenticatedAt: input.authenticatedAt,
    reason: input.reason,
    enabled: input.enabled,
  };
  checkedAccess(record);
  await storage.put(USAGE_ACCESS_KEY, record);
}
function checkedCase(raw: unknown, ref: string): UsageCase | null {
  if (raw === undefined) return null;
  if (
    !object(raw) ||
    !keys(raw, [
      "schema",
      "ref",
      "openedAt",
      "agreement",
      "features",
      "chargedCents",
      "reservedCents",
      "templAnsweredAt",
      "humanReplied",
      "finalAt",
      "excludedAt",
      "dueAt",
      "resolutionDueAt",
    ]) ||
    raw.schema !== 1 ||
    raw.ref !== ref ||
    !REF.test(ref) ||
    !natural(raw.openedAt) ||
    !object(raw.agreement) ||
    !keys(raw.agreement, [
      "id",
      "revision",
      "documentSha256",
      "startsAt",
      "endsAt",
      "terms",
    ]) ||
    !FORM.test(String(raw.agreement.id)) ||
    !natural(raw.agreement.revision) ||
    raw.agreement.revision === 0 ||
    !SHA256.test(String(raw.agreement.documentSha256)) ||
    !natural(raw.agreement.startsAt) ||
    !natural(raw.agreement.endsAt) ||
    !isProductUsageTerms(raw.agreement.terms) ||
    !object(raw.features) ||
    Object.entries(raw.features).some(
      ([feature, at]) =>
        !["walletVerification", "transactionCheck", "aiDraft"].includes(
          feature,
        ) ||
        !natural(at) ||
        at < (raw.openedAt as number),
    ) ||
    ![raw.chargedCents, raw.reservedCents].every(natural) ||
    (raw.chargedCents as number) >
      (raw.agreement.terms as ProductUsageTerms).templAiResolutionUsdCents ||
    typeof raw.humanReplied !== "boolean" ||
    [
      raw.templAnsweredAt,
      raw.finalAt,
      raw.excludedAt,
      raw.dueAt,
      raw.resolutionDueAt,
    ].some((value) => value !== null && !natural(value))
  )
    throw fail();
  const record = raw as UsageCase;
  const featureCents = Object.keys(record.features).reduce(
    (sum, feature) =>
      sum +
      usageFeatureCents(record.agreement.terms, feature as ProductUsageFeature),
    0,
  );
  if (
    record.agreement.endsAt <= record.agreement.startsAt ||
    record.openedAt < record.agreement.startsAt ||
    record.openedAt >= record.agreement.endsAt ||
    record.chargedCents + record.reservedCents >
      (record.agreement.terms.templAiPrincipal
        ? record.agreement.terms.templAiResolutionUsdCents
        : usageCaseReserveCents(record.agreement.terms)) ||
    (record.chargedCents !== featureCents &&
      !(
        record.finalAt !== null &&
        record.agreement.terms.templAiPrincipal &&
        record.chargedCents === record.agreement.terms.templAiResolutionUsdCents
      )) ||
    ((record.finalAt !== null || record.excludedAt !== null) &&
      record.reservedCents !== 0) ||
    [
      record.templAnsweredAt,
      record.finalAt,
      record.excludedAt,
      record.dueAt,
      record.resolutionDueAt,
    ].some((value) => value !== null && value < record.openedAt)
  )
    throw fail();
  return record;
}
async function readUsageCase(storage: Reader, ref: string) {
  const record = checkedCase(await storage.get(`${CASE_PREFIX}${ref}`), ref);
  if (record) await checkedCapturedAgreement(storage, record.agreement);
  return record;
}
async function readUsageCaseForUpdate(storage: Storage, ref: string) {
  const record = await readUsageCase(storage, ref);
  if (!record) return null;
  const allowed = Math.max(
    0,
    usageCaseReserveCents(record.agreement.terms) - record.chargedCents,
  );
  if (record.reservedCents > allowed) {
    const totals = await usageTotals(storage);
    totals.reservedCents -= record.reservedCents - allowed;
    record.reservedCents = allowed;
    await saveTotals(storage, totals);
    await saveCase(storage, record);
  }
  return record;
}
function checkedRow(value: unknown): ProductUsageRow {
  if (
    !object(value) ||
    !keys(
      value,
      ["id", "kind", "at", "cents"],
      [
        "ref",
        "feature",
        "formId",
        "formRevision",
        "documentSha256",
        "priceVersion",
        "referenceSha256",
        "paymentId",
        "operator",
        "reason",
      ],
    ) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9:._-]{8,200}$/.test(value.id) ||
    ![
      "feature",
      "ai-resolution",
      "dispute-credit",
      "payment",
      "forgiveness",
    ].includes(String(value.kind)) ||
    !natural(value.at) ||
    !natural(value.cents) ||
    (value.ref !== undefined && !REF.test(String(value.ref))) ||
    (value.referenceSha256 !== undefined &&
      !SHA256.test(String(value.referenceSha256))) ||
    (value.paymentId !== undefined &&
      (typeof value.paymentId !== "string" ||
        !/^[a-zA-Z0-9:._-]{8,200}$/.test(value.paymentId))) ||
    (value.operator !== undefined &&
      normalizeChatPrincipal(value.operator) !== value.operator) ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" ||
        value.reason.length > 280 ||
        !value.reason.trim()))
  )
    throw fail();
  if (value.kind === "feature" || value.kind === "ai-resolution") {
    if (
      !REF.test(String(value.ref)) ||
      !FORM.test(String(value.formId)) ||
      !natural(value.formRevision) ||
      !value.formRevision ||
      !SHA256.test(String(value.documentSha256)) ||
      typeof value.priceVersion !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.priceVersion) ||
      (value.kind === "feature"
        ? !["walletVerification", "transactionCheck", "aiDraft"].includes(
            String(value.feature),
          )
        : value.feature !== undefined) ||
      value.paymentId !== undefined ||
      value.referenceSha256 !== undefined ||
      value.operator !== undefined ||
      value.reason !== undefined
    )
      throw fail();
  } else if (value.kind === "dispute-credit") {
    if (
      !REF.test(String(value.ref)) ||
      !PRODUCT_DISPUTE_REASONS.includes(value.reason as ProductDisputeReason) ||
      value.paymentId !== undefined ||
      value.referenceSha256 !== undefined ||
      value.feature !== undefined
    )
      throw fail();
  } else if (
    value.cents === 0 ||
    (value.kind === "forgiveness"
      ? !value.operator || !value.reason || value.paymentId !== undefined
      : value.paymentId === undefined &&
        (!value.operator || !value.reason || !value.referenceSha256)) ||
    value.ref !== undefined ||
    value.feature !== undefined
  )
    throw fail();
  return value as ProductUsageRow;
}
type UsageMonth = {
  chargedCents: number;
  disputedCents: number;
  paidCents: number;
  forgivenCents: number;
};
function checkedMonth(value: unknown): UsageMonth {
  if (value === undefined)
    return {
      chargedCents: 0,
      disputedCents: 0,
      paidCents: 0,
      forgivenCents: 0,
    };
  if (
    !object(value) ||
    !keys(value, [
      "chargedCents",
      "disputedCents",
      "paidCents",
      "forgivenCents",
    ]) ||
    !Object.values(value).every(natural)
  )
    throw fail();
  return value as UsageMonth;
}
const monthOf = (at: number) =>
  new Date(at).toISOString().slice(0, 7).replace("-", "");
const monthNet = (value: UsageMonth) =>
  value.chargedCents -
  value.disputedCents -
  value.paidCents -
  value.forgivenCents;
async function writeRow(storage: ProductStorage, row: ProductUsageRow) {
  checkedRow(row);
  const key = `${ROW_PREFIX}${pad(row.at)}:${row.id}`;
  const unique = `product-usage-entry-v1:${row.id}`;
  const previous = await storage.get<ProductUsageRow>(unique);
  if (previous) {
    checkedRow(previous);
    if (JSON.stringify(previous) !== JSON.stringify(row)) throw fail();
    return false;
  }
  const monthKey = `${MONTH_PREFIX}${monthOf(row.at)}`;
  const month = checkedMonth(await storage.get(monthKey));
  const field =
    row.kind === "feature" || row.kind === "ai-resolution"
      ? "chargedCents"
      : row.kind === "dispute-credit"
        ? "disputedCents"
        : row.kind === "payment"
          ? "paidCents"
          : "forgivenCents";
  month[field] += row.cents;
  checkedMonth(month);
  await storage.put(monthKey, month);
  await storage.put(unique, row);
  await storage.put(key, row);
  if (row.ref)
    await storage.put(
      `${CASE_ROW_PREFIX}${row.ref}:${pad(row.at)}:${row.id}`,
      row,
    );
  return true;
}
async function saveCase(storage: Storage, record: UsageCase) {
  await storage.put(`${CASE_PREFIX}${record.ref}`, record);
  if (record.dueAt !== null) {
    await storage.put(`${DUE_PREFIX}${pad(record.dueAt)}:${record.ref}`, true);
    await wakeRoomAt(storage, record.dueAt);
  }
}
async function releaseReservation(storage: ProductStorage, record: UsageCase) {
  const totals = await usageTotals(storage);
  totals.reservedCents -= record.reservedCents;
  record.reservedCents = 0;
  await saveTotals(storage, totals);
}
/** Run in the same room transaction as the first accepted member message. */
export async function openUsageCase(
  storage: Storage,
  ref: string,
  c: SupportCase,
  env: WorkspaceFlagEnv = {},
) {
  if (await readUsageCaseForUpdate(storage, ref)) return;
  const agreement = await activeUsageAgreement(storage, c.openedAt, env);
  if (!agreement || c.excluded.length || c.billingExclusion) return;
  await checkpointStorageDue(storage, env as StorageBillingEnv, Date.now());
  const view = await usageView(storage, c.openedAt, env);
  const reservedCents = usageCaseReserveCents(agreement.terms);
  if (view.availableCreditCents < reservedCents)
    throw new HttpError(
      403,
      "This team can't take new cases right now.",
      undefined,
      "support-credit-limit",
    );
  const record: UsageCase = {
    schema: 1,
    ref,
    openedAt: c.openedAt,
    agreement,
    features: {},
    chargedCents: 0,
    reservedCents,
    templAnsweredAt: null,
    humanReplied: false,
    finalAt: null,
    excludedAt: null,
    dueAt: null,
    resolutionDueAt: null,
  };
  const totals = await usageTotals(storage);
  totals.reservedCents += reservedCents;
  await saveTotals(storage, totals);
  await saveCase(storage, record);
}
export async function recordUsageFeature(
  storage: Storage,
  ref: string,
  feature: ProductUsageFeature,
  at: number,
  env: WorkspaceFlagEnv = {},
  actor?: ChatPrincipalId,
) {
  if (
    !(await featureOn(env, storage, "manualBilling")) ||
    (feature === "aiDraft" && !(await featureOn(env, storage, "aiDrafts")))
  )
    return false;
  const record = await readUsageCaseForUpdate(storage, ref);
  if (
    !record ||
    record.features[feature] !== undefined ||
    record.finalAt !== null ||
    record.excludedAt !== null ||
    at < record.openedAt ||
    (feature === "aiDraft" &&
      (!actor || actor !== record.agreement.terms.templAiPrincipal))
  )
    return false;
  const cents = usageFeatureCents(record.agreement.terms, feature);
  if (record.reservedCents < cents)
    throw new HttpError(
      409,
      "This case needs a billing review before using another paid feature.",
    );
  const totals = await usageTotals(storage);
  record.features[feature] = at;
  record.chargedCents += cents;
  record.reservedCents -= cents;
  totals.chargedCents += cents;
  totals.reservedCents -= cents;
  await writeRow(storage, {
    id: `feature:${ref}:${feature}`,
    kind: "feature",
    at,
    cents,
    ref,
    feature,
    formId: record.agreement.id,
    formRevision: record.agreement.revision,
    documentSha256: record.agreement.documentSha256,
    priceVersion: record.agreement.terms.version,
  });
  await saveTotals(storage, totals);
  await saveCase(storage, record);
  return true;
}
export async function recordDefiniteUsageTransaction(
  storage: Storage,
  ref: string,
  status: string,
  at: number,
  env: WorkspaceFlagEnv = {},
) {
  return ["confirmed", "failed"].includes(status)
    ? recordUsageFeature(storage, ref, "transactionCheck", at, env)
    : false;
}
export async function noteUsageAnswer(
  storage: Storage,
  ref: string,
  input: { at: number; actor?: ChatPrincipalId; bot: boolean; answer: boolean },
) {
  const record = await readUsageCaseForUpdate(storage, ref);
  if (!record || record.finalAt !== null || record.excludedAt !== null) return;
  if (!input.bot) {
    record.humanReplied = true;
    record.resolutionDueAt = null;
  } else if (
    record.agreement.terms.templAiResolutionEnabled === true &&
    input.answer &&
    input.actor === record.agreement.terms.templAiPrincipal
  )
    record.templAnsweredAt = input.at;
  else {
    record.templAnsweredAt = null;
    record.resolutionDueAt = null;
  }
  await saveCase(storage, record);
}
export async function updateUsageCase(
  storage: Storage,
  ref: string,
  c: SupportCase,
  input: {
    at: number;
    reopened?: boolean;
    memberConfirmed?: boolean;
    memberRefused?: boolean;
  },
) {
  const record = await readUsageCaseForUpdate(storage, ref);
  if (!record || record.finalAt !== null || record.excludedAt !== null) return;
  if (c.excluded.includes("spam")) {
    const totals = await usageTotals(storage);
    const cents = availableDisputeCredit(totals, record.chargedCents);
    totals.disputedCents += cents;
    await writeRow(storage, {
      id: `excluded:${ref}`,
      kind: "dispute-credit",
      at: input.at,
      cents,
      ref,
      reason: "spam",
    });
    await saveTotals(storage, totals);
    await releaseReservation(storage, record);
    record.excludedAt = input.at;
    record.dueAt = record.resolutionDueAt = null;
  } else if (input.reopened || input.memberRefused || c.handoffAt !== null) {
    record.resolutionDueAt = null;
    record.dueAt =
      c.resolvedAt !== null || c.abandonedAt !== null
        ? input.at + PRODUCT_RESOLUTION_RULES.finalAfterDays * DAY
        : null;
  } else if (
    input.memberConfirmed &&
    record.agreement.terms.templAiResolutionEnabled === true &&
    record.templAnsweredAt !== null &&
    !record.humanReplied &&
    !c.handoffOpen
  ) {
    record.resolutionDueAt ??=
      input.at + PRODUCT_RESOLUTION_RULES.memberFinalHours * HOUR;
    record.dueAt = record.resolutionDueAt;
  } else if (c.resolvedAt !== null || c.abandonedAt !== null) {
    record.dueAt ??= input.at + PRODUCT_RESOLUTION_RULES.finalAfterDays * DAY;
  }
  await saveCase(storage, record);
}
/** Native alarm finalization; timestamps never come from a client. */
export async function finalizeUsageCases(
  storage: Storage,
  now: number,
  env: WorkspaceFlagEnv = {},
): Promise<number | null> {
  const due = await storage.list({
    prefix: DUE_PREFIX,
    end: `${DUE_PREFIX}${pad(now + 1)}`,
    limit: 100,
  });
  for (const key of due.keys()) {
    await storage.delete(key);
    const ref = key.slice(-16);
    const record = await readUsageCaseForUpdate(storage, ref);
    if (
      !record ||
      record.dueAt === null ||
      record.dueAt > now ||
      record.finalAt !== null ||
      record.excludedAt !== null ||
      key !== `${DUE_PREFIX}${pad(record.dueAt)}:${ref}`
    )
      continue;
    if (!(await featureOn(env, storage, "manualBilling"))) {
      record.dueAt = now + 60_000;
      await saveCase(storage, record);
      continue;
    }
    if (
      record.resolutionDueAt !== null &&
      record.templAnsweredAt !== null &&
      !record.humanReplied &&
      (await usageAiResolutionBillingOn(env, storage, record.agreement.terms))
    ) {
      const cents =
        record.agreement.terms.templAiResolutionUsdCents - record.chargedCents;
      if (cents < 0 || record.reservedCents < cents) throw fail();
      const totals = await usageTotals(storage);
      totals.chargedCents += cents;
      totals.reservedCents -= cents;
      record.chargedCents += cents;
      record.reservedCents -= cents;
      await writeRow(storage, {
        id: `resolution:${ref}`,
        kind: "ai-resolution",
        at: now,
        cents,
        ref,
        formId: record.agreement.id,
        formRevision: record.agreement.revision,
        documentSha256: record.agreement.documentSha256,
        priceVersion: record.agreement.terms.version,
      });
      await saveTotals(storage, totals);
    }
    await releaseReservation(storage, record);
    record.finalAt = now;
    record.dueAt = record.resolutionDueAt = null;
    await saveCase(storage, record);
  }
  const next = await storage.list({ prefix: DUE_PREFIX, limit: 1 });
  return next.size
    ? Number(
        [...next.keys()][0].slice(DUE_PREFIX.length, DUE_PREFIX.length + 16),
      )
    : null;
}
/** Verified transfers and operator-approved external receipts settle this ledger only. */
export async function settleUsagePayment(
  storage: ProductStorage,
  input: {
    id: string;
    cents: number;
    at: number;
    paymentId?: string;
    referenceSha256?: string;
    operator?: ChatPrincipalId;
    reason?: string;
    forgiveness?: boolean;
  },
) {
  if (
    !/^[a-zA-Z0-9:._-]{8,200}$/.test(input.id) ||
    !natural(input.cents) ||
    input.cents === 0 ||
    !natural(input.at) ||
    (input.referenceSha256 !== undefined &&
      !SHA256.test(input.referenceSha256)) ||
    (input.paymentId !== undefined &&
      (typeof input.paymentId !== "string" ||
        !/^[a-zA-Z0-9:._-]{8,200}$/.test(input.paymentId))) ||
    (input.operator !== undefined &&
      normalizeChatPrincipal(input.operator) !== input.operator)
  )
    throw fail();
  if (
    !input.paymentId &&
    (!input.operator ||
      !input.reason ||
      input.reason.length < 3 ||
      (!input.forgiveness && !input.referenceSha256))
  )
    throw new HttpError(
      400,
      "Record the received payment reference or the reason for a credit.",
    );
  const previous = await storage.get<ProductUsageRow>(
    `product-usage-entry-v1:${input.id}`,
  );
  if (previous) {
    if (
      previous.cents !== input.cents ||
      previous.kind !== (input.forgiveness ? "forgiveness" : "payment") ||
      previous.paymentId !== input.paymentId ||
      previous.referenceSha256 !== input.referenceSha256 ||
      previous.operator !== input.operator ||
      previous.reason !== input.reason
    )
      throw new HttpError(
        409,
        "This payment reference already records another amount.",
      );
    return { posted: false, totals: await usageTotals(storage) };
  }
  const totals = await usageTotals(storage);
  if (input.forgiveness && input.cents > totals.dueCents)
    throw new HttpError(400, "Credit no more than the amount due.");
  await writeRow(storage, {
    id: input.id,
    kind: input.forgiveness ? "forgiveness" : "payment",
    at: input.at,
    cents: input.cents,
    ...(input.paymentId ? { paymentId: input.paymentId } : {}),
    ...(input.referenceSha256
      ? { referenceSha256: input.referenceSha256 }
      : {}),
    ...(input.operator ? { operator: input.operator } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  if (input.forgiveness) totals.forgivenCents += input.cents;
  else totals.paidCents += input.cents;
  await saveTotals(storage, totals);
  return { posted: true, totals: await usageTotals(storage) };
}
export async function usageRows(
  storage: Reader & Pick<Storage, "list">,
  input: { after?: string; month?: string } = {},
) {
  const start = input.month
    ? Date.UTC(
        Number(input.month.slice(0, 4)),
        Number(input.month.slice(4)) - 1,
        1,
      )
    : 0;
  const end = input.month
    ? Date.UTC(Number(input.month.slice(0, 4)), Number(input.month.slice(4)), 1)
    : undefined;
  if (input.month && !/^\d{4}(?:0[1-9]|1[0-2])$/.test(input.month))
    throw new HttpError(400, "Choose a month.");
  if (input.after && !/^\d{16}:[a-zA-Z0-9:._-]{8,200}$/.test(input.after))
    throw new HttpError(400, "Invalid cursor.");
  const rows = await storage.list<ProductUsageRow>({
    prefix: ROW_PREFIX,
    limit: 101,
    start: `${ROW_PREFIX}${pad(start)}`,
    ...(end !== undefined ? { end: `${ROW_PREFIX}${pad(end)}` } : {}),
    ...(input.after ? { startAfter: `${ROW_PREFIX}${input.after}` } : {}),
  });
  const entries = [...rows.entries()].slice(0, 100);
  const checked = entries.map(([, value]) => checkedRow(value));
  const cases = [];
  for (const ref of new Set(
    checked.flatMap((row) => (row.ref ? [row.ref] : [])),
  )) {
    const record = await readUsageCase(storage, ref);
    if (!record) throw fail();
    const dispute = checkedDispute(
      await storage.get(`${DISPUTE_PREFIX}${ref}`),
      ref,
    );
    cases.push({
      ref,
      finalAt: record.finalAt,
      disputeUntil:
        record.finalAt !== null &&
        record.excludedAt === null &&
        record.chargedCents > 0
          ? record.finalAt + 30 * DAY
          : null,
      dispute: dispute?.status ?? null,
    });
  }
  return {
    rows: checked,
    cases,
    next: rows.size > 100 ? entries.at(-1)![0].slice(ROW_PREFIX.length) : null,
  };
}

type UsageDispute = {
  schema: 1;
  ref: string;
  reason: ProductDisputeReason;
  text: string | null;
  at: number;
  status: "open" | "credited" | "denied";
  cents: number;
  answeredAt?: number;
  operator?: ChatPrincipalId;
  auto?: true;
};
function checkedDispute(value: unknown, ref: string): UsageDispute | null {
  if (value === undefined) return null;
  if (
    !object(value) ||
    !keys(
      value,
      ["schema", "ref", "reason", "text", "at", "status", "cents"],
      ["answeredAt", "operator", "auto"],
    ) ||
    value.schema !== 1 ||
    value.ref !== ref ||
    !REF.test(ref) ||
    !PRODUCT_DISPUTE_REASONS.includes(value.reason as ProductDisputeReason) ||
    (value.text !== null &&
      (typeof value.text !== "string" ||
        value.text.length > PRODUCT_DISPUTE_TEXT_MAX)) ||
    !natural(value.at) ||
    !natural(value.cents) ||
    !["open", "credited", "denied"].includes(String(value.status)) ||
    (value.operator !== undefined &&
      normalizeChatPrincipal(value.operator) !== value.operator) ||
    (value.answeredAt !== undefined && !natural(value.answeredAt)) ||
    (value.auto !== undefined && value.auto !== true)
  )
    throw fail();
  if (
    value.status === "open"
      ? value.answeredAt !== undefined ||
        value.operator !== undefined ||
        value.auto !== undefined
      : !natural(value.answeredAt) ||
        value.answeredAt < (value.at as number) ||
        (value.auto === true
          ? value.status !== "credited" ||
            value.answeredAt !== value.at ||
            value.operator !== undefined
          : !value.operator)
  )
    throw fail();
  return value as UsageDispute;
}
export async function disputeUsageCharge(
  storage: Storage,
  input: { ref: string; reason: unknown; text: unknown; nowMs: number },
) {
  const record = await readUsageCase(storage, input.ref);
  if (!record) return null;
  if (
    !PRODUCT_DISPUTE_REASONS.includes(input.reason as ProductDisputeReason) ||
    (input.text !== undefined &&
      input.text !== null &&
      (typeof input.text !== "string" ||
        input.text.length > PRODUCT_DISPUTE_TEXT_MAX))
  )
    throw new HttpError(
      400,
      "Choose a reason and keep the note under 281 characters.",
    );
  if (
    record.finalAt === null ||
    record.chargedCents === 0 ||
    record.excludedAt !== null
  )
    throw new HttpError(409, "Only a final charge can be disputed.");
  if (input.nowMs > record.finalAt + 30 * DAY)
    throw new HttpError(409, "The time to dispute this charge has passed.");
  if (await storage.get(`${DISPUTE_PREFIX}${input.ref}`))
    throw new HttpError(409, "This charge is already disputed.");
  const dispute: UsageDispute = {
    schema: 1,
    ref: record.ref,
    reason: input.reason as ProductDisputeReason,
    text:
      typeof input.text === "string" && input.text.trim()
        ? input.text.trim()
        : null,
    at: input.nowMs,
    status: "open",
    cents: record.chargedCents,
  };
  if (
    await takeAutomaticDisputeCredit(
      storage,
      input.nowMs,
      record.humanReplied ? "team-handled" : "ai-only",
      "usage",
    )
  ) {
    const totals = await usageTotals(storage);
    const cents = availableDisputeCredit(totals, dispute.cents);
    totals.disputedCents += cents;
    await writeRow(storage, {
      id: `dispute:${record.ref}`,
      kind: "dispute-credit",
      ref: record.ref,
      at: input.nowMs,
      cents,
      reason: dispute.reason,
    });
    await saveTotals(storage, totals);
    record.excludedAt = input.nowMs;
    await saveCase(storage, record);
    dispute.status = "credited";
    dispute.answeredAt = input.nowMs;
    dispute.auto = true;
  }
  await storage.put(`${DISPUTE_PREFIX}${input.ref}`, dispute);
  return { ref: record.ref, dispute };
}
export async function answerUsageDispute(
  storage: Storage,
  input: {
    ref: string;
    accept: boolean;
    nowMs: number;
    operator: ChatPrincipalId;
  },
) {
  const dispute = checkedDispute(
    await storage.get(`${DISPUTE_PREFIX}${input.ref}`),
    input.ref,
  );
  if (!dispute) return null;
  if (dispute.status !== "open")
    throw new HttpError(409, "This dispute already has an answer.");
  const record = await readUsageCase(storage, input.ref);
  if (
    !record ||
    record.finalAt === null ||
    record.excludedAt !== null ||
    record.chargedCents !== dispute.cents ||
    normalizeChatPrincipal(input.operator) !== input.operator
  )
    throw fail();
  if (input.accept) {
    const totals = await usageTotals(storage);
    const cents = availableDisputeCredit(totals, dispute.cents);
    totals.disputedCents += cents;
    await writeRow(storage, {
      id: `dispute:${record.ref}`,
      kind: "dispute-credit",
      ref: record.ref,
      at: input.nowMs,
      cents,
      reason: dispute.reason,
      operator: input.operator,
    });
    await saveTotals(storage, totals);
    record.excludedAt = input.nowMs;
    await saveCase(storage, record);
  }
  dispute.status = input.accept ? "credited" : "denied";
  dispute.answeredAt = input.nowMs;
  dispute.operator = input.operator;
  await storage.put(`${DISPUTE_PREFIX}${input.ref}`, dispute);
  return { ref: record.ref, dispute };
}
export async function openUsageDisputes(
  storage: Pick<DurableObjectTransaction, "get" | "list">,
) {
  const open: {
    ref: string;
    reason: ProductDisputeReason;
    text: string | null;
    at: string;
    priceCents: number;
    closer?: ProductChargeCloser;
    resolvedBy?: ProductChargeResolvedBy;
    corpus: null;
    usage: true;
  }[] = [];
  let after: string | undefined;
  while (open.length < 100) {
    const page = await storage.list({
      prefix: DISPUTE_PREFIX,
      limit: 100,
      ...(after ? { startAfter: after } : {}),
    });
    for (const [key, value] of page) {
      after = key;
      const dispute = checkedDispute(value, key.slice(DISPUTE_PREFIX.length));
      if (!dispute) throw fail();
      if (dispute.status !== "open") continue;
      const resolution = await finalChargeResolution(storage, dispute.ref);
      open.push({
        ref: dispute.ref,
        reason: dispute.reason,
        text: dispute.text,
        at: new Date(dispute.at).toISOString(),
        priceCents: dispute.cents,
        ...(resolution ?? {}),
        corpus: null,
        usage: true,
      });
      if (open.length === 100) break;
    }
    if (page.size < 100) break;
  }
  return open;
}
export async function usageCaseRows(
  storage: Reader & Pick<Storage, "list">,
  ref: string,
) {
  if (!REF.test(ref)) throw fail();
  return [
    ...(
      await storage.list<ProductUsageRow>({
        prefix: `${CASE_ROW_PREFIX}${ref}:`,
        limit: 20,
      })
    ).values(),
  ].map(checkedRow);
}
export async function usageDeletionSummary(storage: Storage, now: number) {
  await usageTotals(storage);
  if (!(await storage.get(USAGE_TOTALS_KEY))) return undefined;
  let after: string | undefined;
  for (;;) {
    const page = await storage.list({
      prefix: CASE_PREFIX,
      limit: 100,
      ...(after ? { startAfter: after } : {}),
    });
    for (const [key, raw] of page) {
      after = key;
      const record = checkedCase(raw, key.slice(CASE_PREFIX.length));
      if (!record || record.finalAt !== null) continue;
      await releaseReservation(storage, record);
      record.finalAt = now;
      record.dueAt = record.resolutionDueAt = null;
      await saveCase(storage, record);
    }
    if (page.size < 100) break;
  }
  const rows: ProductUsageRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await usageRows(storage, { after: cursor });
    rows.push(...page.rows);
    if (!page.next) break;
    if (rows.length >= 100_000)
      throw new HttpError(
        409,
        "Export the usage ledger before deleting this workspace.",
      );
    cursor = page.next;
  }
  return { ...(await usageTotals(storage)), rows };
}

export async function usageStatement(
  storage: Reader & Pick<Storage, "list">,
  month: string,
): Promise<ProductUsageStatement | undefined> {
  if (!/^\d{4}(?:0[1-9]|1[0-2])$/.test(month))
    throw new HttpError(400, "Choose a month.");
  if (!(await storage.get(USAGE_TOTALS_KEY))) return undefined;
  const aggregate = checkedMonth(await storage.get(`${MONTH_PREFIX}${month}`));
  let openingCents = 0,
    after: string | undefined;
  for (;;) {
    const page = await storage.list({
      prefix: MONTH_PREFIX,
      end: `${MONTH_PREFIX}${month}`,
      limit: 100,
      ...(after ? { startAfter: after } : {}),
    });
    for (const [key, raw] of page) {
      after = key;
      openingCents += monthNet(checkedMonth(raw));
      if (!Number.isSafeInteger(openingCents)) throw fail();
    }
    if (page.size < 100) break;
  }
  const start = Date.UTC(
      Number(month.slice(0, 4)),
      Number(month.slice(4)) - 1,
      1,
    ),
    end = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)), 1);
  const listed = await storage.list({
    prefix: ROW_PREFIX,
    start: `${ROW_PREFIX}${pad(start)}`,
    end: `${ROW_PREFIX}${pad(end)}`,
    limit: 5001,
  });
  const closingCents = openingCents + monthNet(aggregate);
  if (!Number.isSafeInteger(closingCents)) throw fail();
  return {
    ...aggregate,
    openingCents,
    closingCents,
    rows: [...listed.values()].slice(0, 5000).map(checkedRow),
    truncated: listed.size > 5000,
  };
}
