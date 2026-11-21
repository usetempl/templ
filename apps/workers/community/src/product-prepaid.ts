import type { ChatPrincipalId } from "@templ/chat/principal";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { PRODUCT_STARTER_PRICES, PRODUCT_TOP_UP } from "@templ/chat/plans";
import type {
  StandardPaymentMode,
  StandardPrepaidPeriod,
} from "@templ/chat/standard-plan";
import { HttpError } from "./common";
import { markWorkspaceStep } from "./funnel-metrics";
import {
  checkedStandardAiRate,
  type StandardAiRate,
} from "@templ/chat/standard-usage";

type Reader = { get<T = unknown>(key: string): Promise<T | undefined> };
type Storage = Reader & { put(key: string, value: unknown): Promise<unknown> };
export const PREPAID_ACCOUNT_KEY = "product-prepaid-account-v1";
export const PREPAID_PERIOD_PREFIX = "product-prepaid-period-v1:";
const STARTER_AI_LIMIT = "product-starter-ai-limit-v1";
const SPONSORED_SUPPORT = "product-sponsored-support-v1";
const CREDIT = "product-prepaid-credit-v1:";
const DEBIT = "product-prepaid-debit-v1:";
const ATTEMPT = "product-prepaid-attempt-v1:";
const MAX = 10n ** 30n - 1n;
const NANO = /^(?:0|[1-9][0-9]{0,29})$/;
const ID = /^[A-Za-z0-9:_-]{1,180}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = () => new HttpError(503, "Prepaid balance could not be verified.");
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const mode = (value: unknown): value is StandardPaymentMode =>
  ["prepaid", "debt", "custom"].includes(String(value));
/** The operator's arrangement is separate from cash, outstanding debt and usage. */
export async function sponsoredSupport(storage: Reader): Promise<boolean> {
  const saved = await storage.get<boolean>(SPONSORED_SUPPORT);
  if (saved !== undefined && typeof saved !== "boolean") throw fail();
  return saved === true;
}
function amount(value: unknown): bigint {
  if (typeof value !== "string" || !NANO.test(value))
    throw new HttpError(400, "Choose a valid prepaid amount.");
  return BigInt(value);
}
function sum(...values: bigint[]) {
  const value = values.reduce((a, b) => a + b, 0n);
  if (value < 0n || value > MAX) throw fail();
  return value.toString();
}
export async function readStarterAiLimit(storage: Reader): Promise<number> {
  const cents = (await storage.get<number>(STARTER_AI_LIMIT)) ?? 0;
  if (!natural(cents) || cents > PRODUCT_TOP_UP.maxUsdCents) throw fail();
  return cents;
}

export async function setStarterAiLimit(
  storage: Storage,
  cents: unknown,
  expectedCents: unknown,
) {
  if (typeof cents !== "number" || !natural(cents) || cents > PRODUCT_TOP_UP.maxUsdCents)
    throw new HttpError(400, "Enter a valid monthly AI limit.");
  if (expectedCents !== await readStarterAiLimit(storage))
    throw new HttpError(409, "Reload the plan before changing the AI limit.");
  await storage.put(STARTER_AI_LIMIT, cents);
  return cents;
}

/** The reserved cost also counts against the limit until a request settles. */
export async function starterAiRemaining(storage: Reader, period: StandardPrepaidPeriod) {
  if (period.priceVersion !== PRODUCT_STARTER_PRICES.publishedOn) return undefined;
  const limit = BigInt(await readStarterAiLimit(storage)) * 10_000_000n;
  const remaining = limit - amount(period.aiUsageUsdNanos) - amount(period.aiReservedUsdNanos);
  return remaining > 0n ? remaining : 0n;
}

type Account = {
  schemaVersion: 1;
  mode: StandardPaymentMode;
  revision: number;
  cashAvailableUsdNanos: string;
  cashReservedUsdNanos: string;
  cashSpentUsdNanos: string;
};
const fresh = (): Account => ({
  schemaVersion: 1,
  mode: "prepaid",
  revision: 0,
  cashAvailableUsdNanos: "0",
  cashReservedUsdNanos: "0",
  cashSpentUsdNanos: "0",
});
export async function readPrepaidAccount(storage: Reader): Promise<Account> {
  const value = await storage.get<Account>(PREPAID_ACCOUNT_KEY);
  if (value === undefined) return fresh();
  if (
    !value ||
    Object.keys(value).sort().join() !== Object.keys(fresh()).sort().join() ||
    value.schemaVersion !== 1 ||
    !mode(value.mode) ||
    !natural(value.revision)
  )
    throw fail();
  try {
    amount(value.cashAvailableUsdNanos);
    amount(value.cashReservedUsdNanos);
    amount(value.cashSpentUsdNanos);
  } catch {
    throw fail();
  }
  return value;
}
async function save(storage: Storage, account: Account) {
  if (!natural(account.revision + 1)) throw fail();
  account.revision++;
  await storage.put(PREPAID_ACCOUNT_KEY, account);
}
/** The caller checks the current operator and wallet confirmation before this transaction. */
export async function setPrepaidMode(
  storage: Storage,
  input: {
    mode: StandardPaymentMode | "sponsored";
    expectedRevision: number;
    operator: ChatPrincipalId;
    reason: string;
    at: number;
  },
) {
  if (
    !(input.mode === "sponsored" || mode(input.mode)) ||
    !natural(input.expectedRevision) ||
    !natural(input.at) ||
    normalizeChatPrincipal(input.operator) !== input.operator ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 3 ||
    input.reason.length > 280
  )
    throw new HttpError(400, "Choose a billing mode and record the reason.");
  const account = await readPrepaidAccount(storage);
  if (account.revision !== input.expectedRevision)
    throw new HttpError(
      409,
      "Read the current prepaid balance before changing its mode.",
    );
  const wasSponsored = await sponsoredSupport(storage);
  const sponsored = input.mode === "sponsored";
  // Keep the account readable by the existing release during a handover.
  const paymentMode = input.mode === "sponsored" ? "custom" : input.mode;
  if (paymentMode !== account.mode || wasSponsored !== sponsored) {
    const plan = await storage.get<{ currentPeriod: string | null }>(
      "product-standard-plan-v1",
    );
    if (
      plan &&
      !(
        plan.currentPeriod === null ||
        /^\d{16}$/.test(String(plan.currentPeriod))
      )
    )
      throw fail();
    const period = plan?.currentPeriod
      ? await readPrepaidPeriod(storage, plan.currentPeriod)
      : null;
    if (period && input.at >= period.startsAt && input.at < period.endsAt)
      throw new HttpError(
        409,
        "Change this arrangement after the current prepaid month ends.",
      );
    const pending = await storage.get<unknown>("product-prepaid-ai-pending-v1");
    if (
      amount(account.cashReservedUsdNanos) > 0n ||
      (period && amount(period.aiReservedUsdNanos) > 0n) ||
      (pending !== undefined && (!Array.isArray(pending) || pending.length > 0))
    )
      throw new HttpError(
        409,
        "Wait for the recorded AI requests to settle before changing this arrangement.",
      );
  }
  account.mode = paymentMode;
  await save(storage, account);
  if (sponsored !== wasSponsored) await storage.put(SPONSORED_SUPPORT, sponsored);
  await storage.put(`product-prepaid-mode-v1:${account.revision}`, {
    ...input,
    revision: account.revision,
  });
  return account;
}
/** A verified transfer credits once. This never changes a legacy balance or grants staff access. */
export async function creditPrepaid(
  storage: Storage,
  input: { receiptId: string; amountUsdNanos: string; at: number },
) {
  if (
    !ID.test(input.receiptId) ||
    !natural(input.at) ||
    amount(input.amountUsdNanos) <= 0n
  )
    throw new HttpError(400, "Choose a verified payment receipt and amount.");
  const previous = await storage.get<typeof input>(CREDIT + input.receiptId);
  if (previous) {
    if (
      Object.keys(previous).sort().join() !== "amountUsdNanos,at,receiptId" ||
      !natural(previous.at)
    )
      throw fail();
    if (
      previous.receiptId !== input.receiptId ||
      previous.amountUsdNanos !== input.amountUsdNanos
    )
      throw new HttpError(
        409,
        "This receipt already records a different prepaid amount.",
      );
    return { credited: false, account: await readPrepaidAccount(storage) };
  }
  const account = await readPrepaidAccount(storage);
  account.cashAvailableUsdNanos = sum(
    amount(account.cashAvailableUsdNanos),
    amount(input.amountUsdNanos),
  );
  await save(storage, account);
  await storage.put(CREDIT + input.receiptId, input);
  await markWorkspaceStep(storage, "payment_credited", input.at);
  return { credited: true, account };
}
/** Debit only available cash, once, in the same Room transaction as the accepted charge. */
export async function debitPrepaid(
  storage: Storage,
  input: { referenceId: string; amountUsdNanos: string; at: number },
) {
  if (!ID.test(input.referenceId) || !natural(input.at))
    throw new HttpError(400, "Choose a prepaid charge reference.");
  const debit = amount(input.amountUsdNanos);
  const previous = await storage.get<typeof input>(DEBIT + input.referenceId);
  if (previous) {
    if (
      Object.keys(previous).sort().join() !== "amountUsdNanos,at,referenceId" ||
      previous.referenceId !== input.referenceId ||
      !natural(previous.at)
    )
      throw fail();
    if (previous.amountUsdNanos !== input.amountUsdNanos)
      throw new HttpError(
        409,
        "This reference already records a different charge.",
      );
    return { debited: false, account: await readPrepaidAccount(storage) };
  }
  const account = await readPrepaidAccount(storage);
  if (debit > amount(account.cashAvailableUsdNanos))
    throw new HttpError(
      402,
      "Add prepaid credit to cover this usage.",
      undefined,
      "prepaid-credit-required",
    );
  account.cashAvailableUsdNanos = sum(
    amount(account.cashAvailableUsdNanos),
    -debit,
  );
  account.cashSpentUsdNanos = sum(amount(account.cashSpentUsdNanos), debit);
  await save(storage, account);
  await storage.put(DEBIT + input.referenceId, input);
  return { debited: true, account };
}
export async function readPrepaidPeriod(
  storage: Reader,
  id: string,
): Promise<StandardPrepaidPeriod | null> {
  if (!/^\d{16}$/.test(id)) throw fail();
  const row = await storage.get<StandardPrepaidPeriod>(
    PREPAID_PERIOD_PREFIX + id,
  );
  if (row === undefined) return null;
  return checkedPrepaidPeriod(row, id);
}
function checkedPrepaidPeriod(row: StandardPrepaidPeriod, id: string) {
  if (
    !row ||
    Object.keys(row).sort().join() !==
      [
        "readinessPolicy",
        "id",
        "startsAt",
        "endsAt",
        "priceVersion",
        ...(Object.hasOwn(row, "aiRateBasisPoints")
          ? ["aiRateBasisPoints"]
          : ["aiRateMultiplier"]),
        "aiRateCardVersion",
        "includedAiCreditUsdNanos",
        "includedAiAvailableUsdNanos",
        "includedAiReservedUsdNanos",
        "includedAiSpentUsdNanos",
        "aiUsageUsdNanos",
        "aiReservedUsdNanos",
        "aiCashReservedUsdNanos",
        "aiCashSpentUsdNanos",
        "aiAbsorbedAttempts",
      ]
        .sort()
        .join() ||
    row.readinessPolicy !== "grounded_v1" ||
    row.id !== id ||
    !natural(row.startsAt) ||
    !natural(row.endsAt) ||
    row.startsAt >= row.endsAt ||
    row.id !== String(row.startsAt).padStart(16, "0") ||
    !checkedStandardAiRate(row) ||
    !natural(row.aiAbsorbedAttempts) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.priceVersion) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.aiRateCardVersion)
  )
    throw fail();
  try {
    if (
      amount(row.includedAiCreditUsdNanos) !==
      amount(row.includedAiAvailableUsdNanos) +
        amount(row.includedAiReservedUsdNanos) +
        amount(row.includedAiSpentUsdNanos)
    )
      throw fail();
    if (
      amount(row.aiUsageUsdNanos) !==
        amount(row.includedAiSpentUsdNanos) + amount(row.aiCashSpentUsdNanos) ||
      amount(row.aiReservedUsdNanos) !==
        amount(row.includedAiReservedUsdNanos) +
          amount(row.aiCashReservedUsdNanos)
    )
      throw fail();
    const used = amount(row.aiUsageUsdNanos),
      credit = amount(row.includedAiCreditUsdNanos),
      pending = amount(row.aiReservedUsdNanos);
    const spent = used < credit ? used : credit,
      remaining = credit - spent;
    if (
      amount(row.includedAiSpentUsdNanos) !== spent ||
      amount(row.includedAiReservedUsdNanos) !==
        (pending < remaining ? pending : remaining)
    )
      throw fail();
  } catch {
    throw fail();
  }
  return row;
}
export async function openPrepaidPeriod(
  storage: Storage,
  period: StandardAiRate &
    Omit<
      StandardPrepaidPeriod,
      | "aiRateMultiplier"
      | "aiRateBasisPoints"
      | "includedAiAvailableUsdNanos"
      | "includedAiReservedUsdNanos"
      | "includedAiSpentUsdNanos"
      | "aiUsageUsdNanos"
      | "aiReservedUsdNanos"
      | "aiCashReservedUsdNanos"
      | "aiCashSpentUsdNanos"
      | "aiAbsorbedAttempts"
      | "readinessPolicy"
    >,
) {
  const previous = await readPrepaidPeriod(storage, period.id);
  if (previous) {
    for (const [key, value] of Object.entries(period))
      if (previous[key as keyof StandardPrepaidPeriod] !== value)
        throw new HttpError(
          409,
          "This monthly period already has different terms.",
        );
    return previous;
  }
  const row: StandardPrepaidPeriod = {
    ...period,
    readinessPolicy: "grounded_v1",
    includedAiAvailableUsdNanos: period.includedAiCreditUsdNanos,
    includedAiReservedUsdNanos: "0",
    includedAiSpentUsdNanos: "0",
    aiUsageUsdNanos: "0",
    aiReservedUsdNanos: "0",
    aiCashReservedUsdNanos: "0",
    aiCashSpentUsdNanos: "0",
    aiAbsorbedAttempts: 0,
  };
  checkedPrepaidPeriod(row, row.id);
  await storage.put(PREPAID_PERIOD_PREFIX + period.id, row);
  return row;
}
/** Included credit belongs to the whole period, regardless of settlement order. */
function rebalanceAi(
  account: Account,
  period: StandardPrepaidPeriod,
  pendingDelta: bigint,
  usageDelta: bigint,
) {
  const used = amount(period.aiUsageUsdNanos) + usageDelta;
  const pending = amount(period.aiReservedUsdNanos) + pendingDelta;
  if (used < 0n || pending < 0n) throw fail();
  const credit = amount(period.includedAiCreditUsdNanos),
    includedSpent = used < credit ? used : credit;
  const includedRemaining = credit - includedSpent,
    includedReserved =
      pending < includedRemaining ? pending : includedRemaining;
  const cashReserved = pending - includedReserved,
    cashSpent = used - includedSpent;
  const extraCashSpent = cashSpent - amount(period.aiCashSpentUsdNanos);
  const available =
    amount(account.cashAvailableUsdNanos) +
    amount(period.aiCashReservedUsdNanos) -
    cashReserved -
    extraCashSpent;
  if (available < 0n)
    throw new HttpError(
      402,
      "Add prepaid credit to cover this AI request.",
      undefined,
      "prepaid-credit-required",
    );
  account.cashAvailableUsdNanos = sum(available);
  account.cashReservedUsdNanos = sum(
    amount(account.cashReservedUsdNanos),
    cashReserved - amount(period.aiCashReservedUsdNanos),
  );
  account.cashSpentUsdNanos = sum(
    amount(account.cashSpentUsdNanos),
    extraCashSpent,
  );
  period.aiUsageUsdNanos = sum(used);
  period.aiReservedUsdNanos = sum(pending);
  period.aiCashReservedUsdNanos = sum(cashReserved);
  period.aiCashSpentUsdNanos = sum(cashSpent);
  period.includedAiSpentUsdNanos = sum(includedSpent);
  period.includedAiReservedUsdNanos = sum(includedReserved);
  period.includedAiAvailableUsdNanos = sum(
    includedRemaining - includedReserved,
  );
}
export type PrepaidAiReservation = {
  attemptId: string;
  periodId: string;
  maxRetailUsdNanos: string;
  at: number;
  includedHeldUsdNanos: string;
  cashHeldUsdNanos: string;
  status: "reserved" | "settled" | "absorbed";
  actualRetailUsdNanos: string | null;
  settledAt: number | null;
};
export async function readPrepaidAttempt(
  storage: Reader,
  attemptId: string,
): Promise<PrepaidAiReservation | null> {
  if (!UUID.test(attemptId))
    throw new HttpError(400, "Choose a valid AI attempt.");
  const row = await storage.get<PrepaidAiReservation>(ATTEMPT + attemptId);
  if (row === undefined) return null;
  if (
    !row ||
    Object.keys(row).sort().join() !==
      [
        "attemptId",
        "periodId",
        "maxRetailUsdNanos",
        "at",
        "includedHeldUsdNanos",
        "cashHeldUsdNanos",
        "status",
        "actualRetailUsdNanos",
        "settledAt",
      ]
        .sort()
        .join() ||
    row.attemptId !== attemptId ||
    !/^\d{16}$/.test(row.periodId) ||
    !natural(row.at) ||
    !["reserved", "settled", "absorbed"].includes(row.status) ||
    amount(row.includedHeldUsdNanos) + amount(row.cashHeldUsdNanos) !==
      amount(row.maxRetailUsdNanos) ||
    (row.status === "reserved"
      ? row.actualRetailUsdNanos !== null || row.settledAt !== null
      : !natural(row.settledAt) ||
        row.settledAt < row.at ||
        (row.status === "absorbed" && row.actualRetailUsdNanos !== null) ||
        (row.status === "settled" &&
          (row.actualRetailUsdNanos === null ||
            amount(row.actualRetailUsdNanos) > amount(row.maxRetailUsdNanos))))
  )
    throw fail();
  return row;
}
export async function reserveAi(
  storage: Storage,
  input: {
    attemptId: string;
    periodId: string;
    maxRetailUsdNanos: string;
    at: number;
  },
) {
  if (
    !UUID.test(input.attemptId) ||
    !natural(input.at) ||
    amount(input.maxRetailUsdNanos) <= 0n
  )
    throw new HttpError(400, "Choose a valid AI usage reservation.");
  const previous = await readPrepaidAttempt(storage, input.attemptId);
  if (previous) {
    if (
      previous.periodId !== input.periodId ||
      previous.maxRetailUsdNanos !== input.maxRetailUsdNanos
    )
      throw new HttpError(
        409,
        "This AI attempt already has a different reservation.",
      );
    return previous;
  }
  const account = await readPrepaidAccount(storage),
    period = await readPrepaidPeriod(storage, input.periodId);
  if (account.mode !== "prepaid")
    throw new HttpError(
      409,
      "This workspace uses reviewed billing terms.",
      undefined,
      "prepaid-mode-changed",
    );
  if (!period || input.at < period.startsAt || input.at >= period.endsAt)
    throw new HttpError(
      402,
      "Start a paid month before using Templ AI.",
      undefined,
      "prepaid-period-required",
    );
  const maximum = amount(input.maxRetailUsdNanos);
  const remaining = await starterAiRemaining(storage, period);
  if (remaining !== undefined && maximum > remaining)
    throw new HttpError(402, "This AI request exceeds your monthly limit.", undefined, "prepaid-ai-limit");
  const available = amount(period.includedAiAvailableUsdNanos);
  const included = available < maximum ? available : maximum,
    cash = maximum - included;
  rebalanceAi(account, period, maximum, 0n);
  const row: PrepaidAiReservation = {
    ...input,
    includedHeldUsdNanos: included.toString(),
    cashHeldUsdNanos: cash.toString(),
    status: "reserved",
    actualRetailUsdNanos: null,
    settledAt: null,
  };
  await storage.put(PREPAID_PERIOD_PREFIX + period.id, period);
  await save(storage, account);
  await storage.put(ATTEMPT + input.attemptId, row);
  return row;
}
export async function settleAi(
  storage: Storage,
  input: { attemptId: string; actualRetailUsdNanos: string | null; at: number },
) {
  if (!UUID.test(input.attemptId) || !natural(input.at))
    throw new HttpError(400, "Choose a valid AI attempt.");
  const actual =
    input.actualRetailUsdNanos === null
      ? 0n
      : amount(input.actualRetailUsdNanos);
  const row = await readPrepaidAttempt(storage, input.attemptId);
  if (!row)
    throw new HttpError(
      409,
      "Reserve this AI attempt before recording its usage.",
    );
  if (row.status !== "reserved") {
    if (row.actualRetailUsdNanos !== input.actualRetailUsdNanos)
      throw new HttpError(
        409,
        "This AI attempt already has a different settlement.",
      );
    return row;
  }
  if (input.at < row.at || actual > amount(row.maxRetailUsdNanos))
    throw new HttpError(409, "AI usage exceeds its recorded reservation.");
  const account = await readPrepaidAccount(storage),
    period = await readPrepaidPeriod(storage, row.periodId);
  if (!period) throw fail();
  rebalanceAi(account, period, -amount(row.maxRetailUsdNanos), actual);
  if (input.actualRetailUsdNanos === null) {
    if (!natural(period.aiAbsorbedAttempts + 1)) throw fail();
    period.aiAbsorbedAttempts++;
  }
  row.status = input.actualRetailUsdNanos === null ? "absorbed" : "settled";
  row.actualRetailUsdNanos = input.actualRetailUsdNanos;
  row.settledAt = input.at;
  await storage.put(PREPAID_PERIOD_PREFIX + period.id, period);
  await save(storage, account);
  await storage.put(ATTEMPT + input.attemptId, row);
  return row;
}
