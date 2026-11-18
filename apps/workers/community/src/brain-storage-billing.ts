import {
  BRAIN_STORAGE_PRICE,
  brainStorageEstimateCents,
  brainStorageBillingTerms,
} from "@templ/chat/brain-storage";
import { PRODUCT_USAGE_LIMITS } from "@templ/chat/plans";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { HttpError, sha256Hex, type Env } from "./common";
import { knowledgeCall } from "./support-knowledge-client";
import type { KnowledgeEnv } from "./support-knowledge-client";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
import {
  approvedStorageTrial,
  approvedStorageTrialScope,
} from "./brain-storage-trial";
import { activatedReleasedFeatures } from "./release-activation";
import { usageTotals } from "./product-usage-billing";
import { manualTotals } from "./product-manual-billing";
import {
  activeProductOrderForm,
  readProductOrderForms,
} from "./product-order-forms";
import { paymentLedgerCall } from "./product-payment-ledger";
import type { ProductStorage } from "./product-entitlements";
import type { StorageUploadGrant } from "./brain-storage";

export const STORAGE_AGREEMENTS_KEY = "brain-storage-agreements-v1";
export const STORAGE_TOTALS_KEY = "brain-storage-totals-v1";
export const STORAGE_ACCEPTANCE_KEY = "brain-storage-acceptance-v1";
export const STORAGE_ACCEPTANCE_HISTORY_KEY =
  "brain-storage-acceptance-history-v1";
import { STORAGE_DELETION_KEY } from "./brain-storage-keys";
export { STORAGE_DELETION_KEY } from "./brain-storage-keys";
const ROW = "brain-storage-row-v1:";
const MONTH = "brain-storage-month-v1:";
const SHA = /^[a-f0-9]{64}$/;
const WORKSPACE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^BS-\d{4}-\d{3}$/;
const REQUEST =
  /^bsc-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const fail = () => new HttpError(503, "Storage billing could not be checked.");
type Reader = Pick<ProductStorage, "get">;
type Storage = ProductStorage & Pick<DurableObjectTransaction, "list">;
export type StorageBillingEnv = WorkspaceFlagEnv &
  KnowledgeEnv &
  Partial<Pick<Env, "PRODUCT_PAYMENT_LEDGER">>;
export type StorageAgreement = {
  schema: 1;
  id: string;
  revision: number;
  workspace: string;
  documentText: string;
  documentSha256: string;
  termsSha256: string;
  approvedBy: string;
  signedBy: string;
  recordedAt: number;
  startsAt: number;
  endsAt: number;
  price: typeof BRAIN_STORAGE_PRICE;
};
export type StorageAcceptance = {
  schema: 1;
  id: string;
  agreement: StorageAgreement;
  acceptedAt: number;
  withdrawnAt: number | null;
  principal: string;
  debtLimitCents: number;
};
type Agreements = {
  schema: 1;
  history: StorageAgreement[];
  ended: Record<string, number>;
};
export type StorageTotals = {
  schema: 1;
  chargedCents: number;
  paidCents: number;
  creditedCents: number;
  dueCents: number;
};
export type StorageRow = {
  id: string;
  kind: "storage" | "payment" | "credit";
  at: number;
  cents: number;
  agreementId?: string;
  revision?: number;
  documentSha256?: string;
  termsSha256?: string;
  priceVersion?: string;
  scope?: string;
  month?: string;
  byteMs?: string;
  referenceSha256?: string;
  operator?: string;
  reason?: string;
  sources?: {
    scope: string;
    agreementId: string;
    revision: number;
    documentSha256: string;
    termsSha256: string;
    byteMs: string;
  }[];
};
export function storageCollectionQualified(
  env: WorkspaceFlagEnv,
  workspace?: string,
  documentSha256?: string,
  manager?: string,
): boolean {
  if (env.BRAIN_STORAGE_COLLECTION_ENABLED !== "true") return false;
  if (
    env.APP_ORIGIN === "https://usetempl.com" &&
    approvedStorageTrial(env, workspace, documentSha256, manager)
  )
    return true;
  return (
    featureOn(env, undefined, "brainStorageCollection") &&
    (env.APP_ORIGIN !== "https://usetempl.com" ||
      activatedReleasedFeatures(env).includes("brainStorageCollection"))
  );
}
function checkedAgreement(value: unknown): StorageAgreement {
  const a = value as StorageAgreement;
  if (
    !a ||
    a.schema !== 1 ||
    !ID.test(a.id) ||
    !natural(a.revision) ||
    !a.revision ||
    !WORKSPACE.test(a.workspace) ||
    typeof a.documentText !== "string" ||
    a.documentText.length < 20 ||
    a.documentText.length > 48_000 ||
    !SHA.test(a.documentSha256) ||
    !SHA.test(a.termsSha256) ||
    normalizeChatPrincipal(a.approvedBy) !== a.approvedBy ||
    normalizeChatPrincipal(a.signedBy) !== a.signedBy ||
    ![a.recordedAt, a.startsAt, a.endsAt].every(natural) ||
    a.endsAt <= a.startsAt ||
    a.endsAt - a.startsAt > 366 * 86_400_000 ||
    JSON.stringify(a.price) !== JSON.stringify(BRAIN_STORAGE_PRICE)
  )
    throw fail();
  return a;
}
async function agreements(storage: Reader): Promise<Agreements> {
  const value = (await storage.get<Agreements>(STORAGE_AGREEMENTS_KEY)) ?? {
    schema: 1,
    history: [],
    ended: {},
  };
  if (
    value.schema !== 1 ||
    !Array.isArray(value.history) ||
    value.history.length > 256 ||
    !value.ended ||
    typeof value.ended !== "object"
  )
    throw fail();
  const seen = new Set<string>();
  for (const raw of value.history) {
    const a = checkedAgreement(raw),
      key = `${a.id}:${a.revision}`;
    if (
      seen.has(key) ||
      (await sha256Hex(a.documentText)) !== a.documentSha256 ||
      (await sha256Hex(brainStorageBillingTerms())) !== a.termsSha256
    )
      throw fail();
    seen.add(key);
  }
  for (const [key, at] of Object.entries(value.ended))
    if (!seen.has(key) || !natural(at)) throw fail();
  return value;
}
/** Existing signed storage terms stay visible after their feature flag closes. */
export async function hasStorageAgreement(storage: Reader): Promise<boolean> {
  return (await agreements(storage)).history.length > 0;
}
export async function storageTotals(storage: Reader): Promise<StorageTotals> {
  const totals = (await storage.get<StorageTotals>(STORAGE_TOTALS_KEY)) ?? {
    schema: 1,
    chargedCents: 0,
    paidCents: 0,
    creditedCents: 0,
    dueCents: 0,
  };
  if (
    totals.schema !== 1 ||
    ![
      totals.chargedCents,
      totals.paidCents,
      totals.creditedCents,
      totals.dueCents,
    ].every(natural) ||
    totals.chargedCents - totals.paidCents - totals.creditedCents !==
      totals.dueCents
  )
    throw fail();
  return totals;
}
async function acceptanceHistory(
  storage: Reader,
): Promise<StorageAcceptance[]> {
  const history =
    (await storage.get<StorageAcceptance[]>(STORAGE_ACCEPTANCE_HISTORY_KEY)) ??
    [];
  const state = await agreements(storage),
    seen = new Set<string>();
  if (!Array.isArray(history) || history.length > 256) throw fail();
  for (const value of history) {
    if (
      value.schema !== 1 ||
      !REQUEST.test(value.id) ||
      seen.has(value.id) ||
      !natural(value.acceptedAt) ||
      !(
        value.withdrawnAt === null ||
        (natural(value.withdrawnAt) && value.withdrawnAt >= value.acceptedAt)
      ) ||
      normalizeChatPrincipal(value.principal) !== value.principal ||
      value.principal !== value.agreement?.signedBy ||
      !natural(value.debtLimitCents) ||
      !value.debtLimitCents ||
      value.debtLimitCents > PRODUCT_USAGE_LIMITS.debtLimitCents
    )
      throw fail();
    checkedAgreement(value.agreement);
    if (
      !state.history.some(
        (a) => JSON.stringify(a) === JSON.stringify(value.agreement),
      )
    )
      throw fail();
    seen.add(value.id);
  }
  return history;
}
async function acceptance(storage: Reader): Promise<StorageAcceptance | null> {
  const value = await storage.get<StorageAcceptance>(STORAGE_ACCEPTANCE_KEY);
  if (value === undefined) return null;
  const history = await acceptanceHistory(storage);
  if (!history.some((row) => JSON.stringify(row) === JSON.stringify(value)))
    throw fail();
  return value;
}
async function saveAcceptance(storage: Storage, value: StorageAcceptance) {
  const history = await acceptanceHistory(storage),
    index = history.findIndex((row) => row.id === value.id);
  if (index < 0) history.push(value);
  else history[index] = value;
  if (history.length > 256) throw fail();
  await storage.put(STORAGE_ACCEPTANCE_HISTORY_KEY, history);
  await storage.put(STORAGE_ACCEPTANCE_KEY, value);
}
async function native(storage: Reader) {
  const row = await storage.get<{ room: { id: string; manager: string } }>(
    "native-room",
  );
  if (
    !row ||
    !WORKSPACE.test(row.room.id) ||
    normalizeChatPrincipal(row.room.manager) !== row.room.manager ||
    (await storage.get("workspace-deletion-v1"))
  )
    throw fail();
  return row.room;
}
export async function recordStorageAgreement(
  storage: Storage,
  input: StorageAgreement,
) {
  checkedAgreement(input);
  const room = await native(storage);
  if (
    input.workspace !== room.id ||
    input.signedBy !== room.manager ||
    input.endsAt <= input.recordedAt ||
    !input.documentText.includes(brainStorageBillingTerms()) ||
    (await sha256Hex(input.documentText)) !== input.documentSha256 ||
    (await sha256Hex(brainStorageBillingTerms())) !== input.termsSha256
  )
    throw new HttpError(
      409,
      "Review the signed storage document and current workspace manager.",
    );
  if (
    (await readProductOrderForms(storage)).history.some(
      (a) => a.documentSha256 === input.documentSha256,
    )
  )
    throw new HttpError(409, "Use a separate signed storage document.");
  const state = await agreements(storage),
    key = `${input.id}:${input.revision}`;
  const prior = state.history.find((a) => `${a.id}:${a.revision}` === key);
  if (prior) {
    if (
      JSON.stringify({ ...prior, recordedAt: input.recordedAt }) !==
      JSON.stringify(input)
    )
      throw new HttpError(
        409,
        "This storage agreement already records another document.",
      );
    return;
  }
  if (
    state.history.length >= 256 ||
    state.history.some(
      (a) =>
        !state.ended[`${a.id}:${a.revision}`] &&
        a.startsAt < input.endsAt &&
        input.startsAt < a.endsAt,
    )
  )
    throw new HttpError(
      409,
      "End the current storage agreement before recording another.",
    );
  state.history.push(structuredClone(input));
  await storage.put(STORAGE_AGREEMENTS_KEY, state);
}
async function activeAgreement(storage: Reader, now: number) {
  const state = await agreements(storage);
  if (!state.history.length) return null;
  const room = await native(storage);
  return (
    [...state.history]
      .reverse()
      .find(
        (a) =>
          a.workspace === room.id &&
          a.signedBy === room.manager &&
          a.startsAt <= now &&
          now <
            Math.min(
              a.endsAt,
              state.ended[`${a.id}:${a.revision}`] ?? a.endsAt,
            ),
      ) ?? null
  );
}
/** Preserve the workspace's signed cap; new standard accounts use $1,000. */
async function workspaceDebtLimit(storage: Reader, now: number) {
  const form = await activeProductOrderForm(storage, now);
  const history = form?.usage
    ? []
    : (await readProductOrderForms(storage)).history;
  return (
    form?.usage?.debtLimitCents ??
    [...history].reverse().find((row) => row.usage && row.startsAt <= now)
      ?.usage?.debtLimitCents ??
    PRODUCT_USAGE_LIMITS.debtLimitCents
  );
}
async function storageDebtLimit(storage: Reader, now: number) {
  return Math.min(
    await workspaceDebtLimit(storage, now),
    (await acceptance(storage))?.debtLimitCents ??
      PRODUCT_USAGE_LIMITS.debtLimitCents,
  );
}
/** Fresh Room authority is required for paid imports and answer use. */
export async function storageReadGrant(
  storage: Storage,
  env: StorageBillingEnv,
  now: number,
): Promise<StorageUploadGrant | null> {
  const a = await activeAgreement(storage, now),
    accepted = await acceptance(storage);
  if (!a || !accepted) return null;
  if (
    accepted.withdrawnAt !== null ||
    accepted.principal !== a.signedBy ||
    accepted.acceptedAt > now ||
    JSON.stringify(accepted.agreement) !== JSON.stringify(a) ||
    !storageCollectionQualified(env, a.workspace, a.documentSha256, a.signedBy)
  )
    return null;
  try {
    const totals = await checkpointStorageDue(storage, env, now);
    const usage = await usageTotals(storage),
      manual = await manualTotals(storage);
    if (
      totals.dueCents +
        usage.dueCents +
        usage.reservedCents +
        manual.dueCents >=
      (await storageDebtLimit(storage, now))
    )
      return null;
  } catch (error) {
    if (
      error instanceof HttpError &&
      (error.status === 503 || error.reason === "storage-credit-limit")
    )
      return null;
    throw error;
  }
  return { scope: accepted.id, documentSha256: a.documentSha256 };
}
/** A reply must recheck its stored sources after model work completes. */
export async function assertBrainAnswerSources(
  storage: Storage,
  env: StorageBillingEnv,
  principal: string,
  sources: unknown,
  now: number,
) {
  if (!Array.isArray(sources)) return;
  const ids = sources
    .slice(0, 8)
    .map((source) => source?.id)
    .filter(
      (id): id is string =>
        typeof id === "string" &&
        /^kb:kb-[a-f0-9]{16}-[1-9][0-9]{0,3}$/.test(id),
    );
  if (!ids.length) return;
  const grant = await storageReadGrant(storage, env, now);
  const result = await knowledgeCall<{ visibility: Record<string, string> }>(
    env,
    `room:${(await native(storage)).id}`,
    "sources.visibility",
    { role: "bot", principal },
    { ids, storageGrant: grant },
  );
  if (
    ids.some(
      (id) => !result.visibility?.[id] || result.visibility[id] === "unknown",
    )
  )
    throw new HttpError(
      409,
      "An answer source is unavailable. Ask your team to reply.",
      undefined,
      "storage-source-unavailable",
    );
}
/** Knowledge checks whether a grant is needed after counting the final bytes. */
export async function storageUploadGrant(
  storage: Storage,
  env: StorageBillingEnv,
  principal: string,
  now: number,
  humanEditor = false,
): Promise<StorageUploadGrant | null> {
  if ((await storage.get(STORAGE_AGREEMENTS_KEY)) === undefined) return null;
  if (principal !== (await native(storage)).manager && humanEditor !== true)
    throw new HttpError(404, "Not found.");
  return storageReadGrant(storage, env, now);
}
export async function acceptStorageAgreement(
  storage: Storage,
  env: StorageBillingEnv,
  input: {
    principal: string;
    requestId: unknown;
    agreementId: unknown;
    revision: unknown;
    documentSha256: unknown;
    termsSha256: unknown;
  },
  now: number,
) {
  const room = await native(storage),
    a = await activeAgreement(storage, now);
  if (
    !storageCollectionQualified(
      env,
      a?.workspace,
      a?.documentSha256,
      a?.signedBy,
    )
  )
    throw new HttpError(404, "Not found.");
  if (
    !a ||
    input.principal !== room.manager ||
    input.agreementId !== a.id ||
    input.revision !== a.revision ||
    input.documentSha256 !== a.documentSha256 ||
    input.termsSha256 !== a.termsSha256 ||
    typeof input.requestId !== "string" ||
    !REQUEST.test(input.requestId)
  )
    throw new HttpError(
      409,
      "Review the current signed storage agreement again.",
    );
  const trial =
    env.APP_ORIGIN === "https://usetempl.com"
      ? approvedStorageTrialScope(
          env,
          a.workspace,
          a.documentSha256,
          a.signedBy,
          now,
        )
      : undefined;
  if (
    trial &&
    (a.id !== trial.agreementId ||
      a.revision !== trial.revision ||
      a.startsAt !== trial.startsAt ||
      a.endsAt !== trial.endsAt ||
      a.termsSha256 !== trial.termsSha256)
  )
    throw new HttpError(
      409,
      "Review the exact disposable storage agreement again.",
    );
  const old = await acceptance(storage);
  if (old?.id === input.requestId) {
    if (
      JSON.stringify(old.agreement) !== JSON.stringify(a) ||
      old.principal !== input.principal ||
      old.withdrawnAt !== null
    )
      throw new HttpError(409, "This storage confirmation was already used.");
    return;
  }
  if (old && old.withdrawnAt === null)
    throw new HttpError(409, "Withdraw the current storage agreement first.");
  const captured: StorageAcceptance = {
    schema: 1,
    id: input.requestId,
    agreement: a,
    acceptedAt: now,
    withdrawnAt: null,
    principal: input.principal,
    debtLimitCents: Math.min(
      await workspaceDebtLimit(storage, now),
      trial?.debtLimitCents ?? PRODUCT_USAGE_LIMITS.debtLimitCents,
    ),
  };
  const authorization = await knowledgeCall<{ record: StorageAcceptance }>(
    env,
    `room:${room.id}`,
    "knowledge.storage.authorize",
    { role: "manager", principal: input.principal },
    { record: captured },
  );
  const actual = authorization.record;
  if (
    !actual ||
    actual.id !== captured.id ||
    actual.principal !== captured.principal ||
    actual.withdrawnAt !== null ||
    !natural(actual.acceptedAt) ||
    actual.acceptedAt > now ||
    JSON.stringify(actual.agreement) !== JSON.stringify(a) ||
    actual.debtLimitCents !== captured.debtLimitCents
  )
    throw fail();
  await saveAcceptance(storage, actual);
}
async function stopStorageAcceptance(
  storage: Storage,
  env: StorageBillingEnv,
  room: { id: string; manager: string },
  accepted: StorageAcceptance,
  now: number,
): Promise<StorageAcceptance> {
  const stopped = await knowledgeCall<{ stoppedAt: number }>(
    env,
    `room:${room.id}`,
    "knowledge.storage.stop",
    { role: "manager", principal: room.manager },
    { scope: accepted.id },
  );
  if (
    !natural(stopped.stoppedAt) ||
    stopped.stoppedAt < accepted.acceptedAt ||
    stopped.stoppedAt > now + 10_000
  )
    throw fail();
  const actual = { ...accepted, withdrawnAt: stopped.stoppedAt };
  await saveAcceptance(storage, actual);
  return actual;
}
/** Native Knowledge checkpoints are cumulative. Room transactions post only their positive difference. */
export async function checkpointStorageDue(
  storage: Storage,
  env: StorageBillingEnv,
  now: number,
): Promise<StorageTotals> {
  const totals = await storageTotals(storage),
    history = await acceptanceHistory(storage);
  if (!history.length) return totals;
  const room = await native(storage),
    state = await agreements(storage);
  type Snapshot = {
    scope: string;
    documentSha256: string;
    measuredAt: number;
    months: { month: string; byteMs: string; monthMs: number }[];
  };
  const closedScopes: (Snapshot & { closedAt: number })[] = [];
  const grouped = new Map<
    string,
    {
      month: string;
      monthMs: number;
      byteMs: bigint;
      sources: NonNullable<StorageRow["sources"]>;
    }
  >();
  for (let accepted of history) {
    const a = accepted.agreement;
    if (a.workspace !== room.id) throw fail();
    const qualified = storageCollectionQualified(
      env,
      a.workspace,
      a.documentSha256,
      a.signedBy,
    );
    const closed = await storage.get<Snapshot & { closedAt: number }>(
      `${MONTH}closed:${accepted.id}`,
    );
    const frozen = await storage.get<{
      snapshot: Snapshot & { closedAt: number };
      sha256: string;
    }>(`${MONTH}frozen:${accepted.id}`);
    if (
      frozen &&
      (!frozen.snapshot ||
        !SHA.test(frozen.sha256) ||
        frozen.sha256 !== (await sha256Hex(JSON.stringify(frozen.snapshot))) ||
        (closed && JSON.stringify(closed) !== JSON.stringify(frozen.snapshot)))
    )
      throw fail();
    const final = closed ?? frozen?.snapshot;
    if (!final && !qualified && accepted.withdrawnAt === null)
      accepted = await stopStorageAcceptance(storage, env, room, accepted, now);
    const end = Math.min(
      a.endsAt,
      state.ended[`${a.id}:${a.revision}`] ?? a.endsAt,
      accepted.withdrawnAt ?? a.endsAt,
    );
    if (final && (final.closedAt !== end || end > now + 10_000)) throw fail();
    const snapshot =
      final ??
      (await knowledgeCall<Snapshot>(
        env,
        `room:${room.id}`,
        "knowledge.storage.snapshot",
        { role: "manager", principal: room.manager },
        { scope: accepted.id },
      ));
    if (
      snapshot.scope !== accepted.id ||
      snapshot.documentSha256 !== a.documentSha256 ||
      !natural(snapshot.measuredAt) ||
      snapshot.measuredAt < (final ? end : now) ||
      snapshot.measuredAt > now + 10_000 ||
      !Array.isArray(snapshot.months) ||
      snapshot.months.length > 14
    )
      throw fail();
    if (!qualified && end > snapshot.measuredAt)
      throw new HttpError(
        503,
        "Storage collection is closed. Withdraw its agreement before adding spend.",
        undefined,
        "storage-collection-unqualified",
      );
    if (end <= snapshot.measuredAt && !closed)
      closedScopes.push({ ...snapshot, closedAt: end });
    const priorMonths = await storage.list<{ byteMs: string }>({
      prefix: `${MONTH}scope:${accepted.id}:`,
      limit: 15,
    });
    if (
      priorMonths.size > 14 ||
      (closed && priorMonths.size !== snapshot.months.length)
    )
      throw fail();
    const seen = new Set<string>();
    for (const month of snapshot.months) {
      if (
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(month.month) ||
        seen.has(month.month) ||
        !/^(0|[1-9]\d*)$/.test(month.byteMs)
      )
        throw fail();
      seen.add(month.month);
      const [year, number] = month.month.split("-").map(Number),
        start = Date.UTC(year, number - 1),
        endOfMonth = Date.UTC(year, number);
      if (
        month.monthMs !== endOfMonth - start ||
        start >= snapshot.measuredAt ||
        endOfMonth <= accepted.acceptedAt ||
        start >= end
      )
        throw fail();
      const prior = priorMonths.get(
        `${MONTH}scope:${accepted.id}:${month.month}`,
      );
      if (
        (closed && (!prior || prior.byteMs !== month.byteMs)) ||
        (prior &&
          (!/^(0|[1-9]\d*)$/.test(prior.byteMs) ||
            BigInt(prior.byteMs) > BigInt(month.byteMs)))
      )
        throw fail();
      const item = grouped.get(month.month) ?? {
        month: month.month,
        monthMs: month.monthMs,
        byteMs: 0n,
        sources: [],
      };
      item.byteMs += BigInt(month.byteMs);
      item.sources.push({
        scope: accepted.id,
        agreementId: a.id,
        revision: a.revision,
        documentSha256: a.documentSha256,
        termsSha256: a.termsSha256,
        byteMs: month.byteMs,
      });
      grouped.set(month.month, item);
    }
    if (
      [...priorMonths.keys()].some(
        (key) => !seen.has(key.slice(`${MONTH}scope:${accepted.id}:`.length)),
      )
    )
      throw fail();
  }
  const pending: {
    key: string;
    byteMs: string;
    cents: number;
    previous: number;
    month: string;
    sources: NonNullable<StorageRow["sources"]>;
  }[] = [];
  for (const item of grouped.values()) {
    const key = `${MONTH}total:${BRAIN_STORAGE_PRICE.version}:${item.month}`,
      prior = await storage.get<{ byteMs: string; cents: number }>(key);
    if (
      prior &&
      (!natural(prior.cents) ||
        !/^(0|[1-9]\d*)$/.test(prior.byteMs) ||
        BigInt(prior.byteMs) > item.byteMs)
    )
      throw fail();
    const cents = brainStorageEstimateCents(
        item.byteMs.toString(),
        item.monthMs,
      ),
      previous = prior?.cents ?? 0;
    if (cents < previous) throw fail();
    pending.push({
      key,
      byteMs: item.byteMs.toString(),
      cents,
      previous,
      month: item.month,
      sources: item.sources,
    });
  }
  const delta = pending.reduce((sum, row) => sum + row.cents - row.previous, 0);
  for (const snapshot of closedScopes) {
    const key = `${MONTH}frozen:${snapshot.scope}`;
    if ((await storage.get(key)) === undefined)
      await storage.put(key, {
        snapshot,
        sha256: await sha256Hex(JSON.stringify(snapshot)),
      });
  }
  const usage = await usageTotals(storage),
    manual = await manualTotals(storage);
  if (!natural(delta)) throw fail();
  if (
    delta > 0 &&
    totals.dueCents +
      delta +
      usage.dueCents +
      usage.reservedCents +
      manual.dueCents >
      (await storageDebtLimit(storage, now))
  ) {
    const error = new HttpError(
      403,
      "The workspace reached its debt limit. Pay the amount due or remove uploaded files.",
      undefined,
      "storage-credit-limit",
    );
    Object.assign(error, { pendingCents: delta });
    throw error;
  }
  for (const p of pending) {
    if (p.cents > p.previous) {
      const id = `${BRAIN_STORAGE_PRICE.version}:${p.month}:${p.cents}`;
      const row: StorageRow = {
        id,
        kind: "storage",
        at: now,
        cents: p.cents - p.previous,
        priceVersion: BRAIN_STORAGE_PRICE.version,
        month: p.month,
        byteMs: p.byteMs,
        sources: p.sources,
      };
      await storage.put(`${ROW}${id}`, row);
    }
    await storage.put(p.key, { byteMs: p.byteMs, cents: p.cents });
    for (const source of p.sources)
      await storage.put(`${MONTH}scope:${source.scope}:${p.month}`, {
        byteMs: source.byteMs,
      });
  }
  totals.chargedCents += delta;
  totals.dueCents += delta;
  await storage.put(STORAGE_TOTALS_KEY, totals);
  for (const closed of closedScopes)
    await storage.put(`${MONTH}closed:${closed.scope}`, closed);
  return totals;
}
export async function storageBillingView(
  storage: Storage,
  env: StorageBillingEnv,
  now: number,
) {
  const a = await activeAgreement(storage, now);
  let accepted = await acceptance(storage);
  const qualified = storageCollectionQualified(
    env,
    a?.workspace,
    a?.documentSha256,
    a?.signedBy,
  );
  let pendingSettlement = false,
    meterUnavailable = false,
    pendingCents = 0;
  let totals: StorageTotals;
  try {
    totals = await checkpointStorageDue(storage, env, now);
  } catch (error) {
    if (
      !(error instanceof HttpError) ||
      (error.reason !== "storage-credit-limit" && error.status !== 503)
    )
      throw error;
    totals = await storageTotals(storage);
    pendingSettlement = true;
    meterUnavailable = error.status === 503;
    pendingCents =
      (error as HttpError & { pendingCents?: number }).pendingCents ?? 0;
  }
  accepted = await acceptance(storage);
  const debtLimitCents = await storageDebtLimit(storage, now);
  const usage = await usageTotals(storage),
    manual = await manualTotals(storage);
  const creditClosed =
    totals.dueCents + usage.dueCents + usage.reservedCents + manual.dueCents >=
    debtLimitCents;
  return {
    ...totals,
    pendingSettlement,
    pendingCents,
    meterUnavailable,
    debtLimitCents,
    collectionQualified: qualified,
    agreement: a ?? accepted?.agreement ?? null,
    accepted: accepted?.withdrawnAt === null ? accepted : null,
    status: !qualified
      ? "off"
      : pendingSettlement || creditClosed
        ? "paused"
        : !a
          ? "agreement-needed"
          : !accepted || accepted.withdrawnAt !== null
            ? "acceptance-needed"
            : "active",
  };
}
export async function withdrawStorageAgreement(
  storage: Storage,
  env: StorageBillingEnv,
  principal: string,
  now: number,
) {
  const room = await native(storage),
    a = await acceptance(storage);
  if (principal !== room.manager) throw new HttpError(404, "Not found.");
  if (!a || a.withdrawnAt !== null) return;
  await stopStorageAcceptance(storage, env, room, a, now);
  try {
    await checkpointStorageDue(storage, env, now);
  } catch (error) {
    if (
      !(error instanceof HttpError) ||
      (error.reason !== "storage-credit-limit" && error.status !== 503)
    )
      throw error;
  }
}
/** External receipts remain distinct from usage payments and prepaid funds. */
function receiptReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 3 &&
    value.length <= 280
  );
}
export async function creditStorageReceipt(
  storage: Storage,
  input: {
    id: string;
    cents: number;
    referenceSha256: string;
    operator: string;
    at: number;
    kind: "payment" | "credit";
    reason: string;
  },
  env: StorageBillingEnv,
) {
  if (
    !/^[a-zA-Z0-9:_-]{8,120}$/.test(input.id) ||
    !natural(input.cents) ||
    !input.cents ||
    !SHA.test(input.referenceSha256) ||
    normalizeChatPrincipal(input.operator) !== input.operator ||
    !natural(input.at) ||
    !receiptReason(input.reason) ||
    !["payment", "credit"].includes(input.kind)
  )
    throw fail();
  const key = `${ROW}${input.kind}:${input.referenceSha256}`,
    prior = await storage.get<StorageRow>(key);
  if (prior) {
    if (
      prior.cents !== input.cents ||
      prior.referenceSha256 !== input.referenceSha256 ||
      prior.operator !== input.operator ||
      prior.reason !== input.reason
    )
      throw new HttpError(
        409,
        "This storage receipt already records different details.",
      );
    return;
  }
  const totals = await storageTotals(storage);
  if (input.cents > totals.dueCents)
    throw new HttpError(400, "Record no more than the storage amount due.");
  if (input.kind === "payment")
    await paymentLedgerCall(env, "claim-external", {
      workspace: `room:${(await native(storage)).id}`,
      cents: input.cents,
      referenceSha256: input.referenceSha256,
      scope: "storage",
    });
  const row: StorageRow = {
    ...input,
    id: `${input.kind}:${input.referenceSha256}`,
  };
  await storage.put(key, row);
  if (input.kind === "payment") totals.paidCents += input.cents;
  else totals.creditedCents += input.cents;
  totals.dueCents -= input.cents;
  await storage.put(STORAGE_TOTALS_KEY, totals);
}
export async function storageRows(storage: Storage) {
  const rows: StorageRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await storage.list<StorageRow>({
      prefix: ROW,
      ...(after ? { startAfter: after } : {}),
      limit: 1_000,
    });
    for (const [key, row] of page) {
      if (
        !row ||
        key !== `${ROW}${row.id}` ||
        !["storage", "payment", "credit"].includes(row.kind) ||
        !natural(row.at) ||
        !natural(row.cents) ||
        !row.cents ||
        (row.kind !== "storage" && !receiptReason(row.reason))
      )
        throw fail();
      rows.push(row);
    }
    if (page.size < 1_000) return rows;
    after = [...page.keys()].at(-1);
  }
}
/** The manager receives one bounded page without external payment references. */
export async function storageLedgerPage(storage: Storage, after: unknown) {
  if (
    after !== undefined &&
    after !== null &&
    (typeof after !== "string" || !/^[a-zA-Z0-9:_-]{8,180}$/.test(after))
  )
    throw new HttpError(400, "Open the storage ledger again.");
  const page = await storage.list<StorageRow>({
    prefix: ROW,
    ...(after ? { end: `${ROW}${after}` } : {}),
    reverse: true,
    limit: 51,
  });
  const rows = [...page].slice(0, 50).map(([key, row]) => {
    if (
      !row ||
      key !== `${ROW}${row.id}` ||
      !["storage", "payment", "credit"].includes(row.kind) ||
      !natural(row.at) ||
      !natural(row.cents) ||
      !row.cents ||
      (row.kind !== "storage" && !receiptReason(row.reason))
    )
      throw fail();
    return {
      id: row.id,
      kind: row.kind,
      at: row.at,
      cents: row.cents,
      ...(row.month ? { month: row.month } : {}),
    };
  });
  return { rows, next: page.size > 50 ? rows.at(-1)!.id : null };
}
export async function endStorageAgreement(
  storage: Storage,
  env: StorageBillingEnv,
  id: string,
  revision: number,
  now: number,
) {
  const state = await agreements(storage),
    a = state.history.find((a) => a.id === id && a.revision === revision);
  if (!a) throw new HttpError(404, "Not found.");
  const current = await acceptance(storage);
  if (
    current?.agreement.id === id &&
    current.agreement.revision === revision &&
    current.withdrawnAt === null
  )
    await withdrawStorageAgreement(
      storage,
      env,
      (await native(storage)).manager,
      now,
    );
  const stopped = await acceptance(storage);
  state.ended[`${id}:${revision}`] ??=
    stopped?.agreement.id === id && stopped.agreement.revision === revision
      ? (stopped.withdrawnAt ?? now)
      : now;
  await storage.put(STORAGE_AGREEMENTS_KEY, state);
}

/** Close and settle the original signed scope before replacing its manager. */
export async function finalizeStorageManagerTransfer(
  storage: Storage,
  env: StorageBillingEnv,
  now: number,
) {
  if ((await storage.get(STORAGE_AGREEMENTS_KEY)) === undefined) return;
  const room = await native(storage),
    agreement = await activeAgreement(storage, now);
  await withdrawStorageAgreement(storage, env, room.manager, now);
  await checkpointStorageDue(storage, env, now);
  if (agreement)
    await endStorageAgreement(
      storage,
      env,
      agreement.id,
      agreement.revision,
      now,
    );
}

export async function storageCapacityDebt(storage: Reader) {
  const totals = await storageTotals(storage);
  if ((await storage.get(STORAGE_AGREEMENTS_KEY)) === undefined)
    return totals.dueCents;
  return totals.dueCents + (await manualTotals(storage)).dueCents;
}
/** Preserve signed scope, posted rows and the final native integral before knowledge is erased. */
export async function prepareStorageDeletion(
  storage: Storage,
  env: StorageBillingEnv,
  room: string,
  principal: string,
  now: number,
) {
  if (
    (await storage.get(STORAGE_DELETION_KEY)) !== undefined ||
    (await storage.get(STORAGE_AGREEMENTS_KEY)) === undefined
  )
    return;
  const accepted = await acceptance(storage),
    history = await acceptanceHistory(storage);
  const meterSnapshots: unknown[] = [];
  if (accepted)
    await knowledgeCall(
      env,
      room,
      "knowledge.storage.stop",
      { role: "manager", principal },
      { scope: accepted.id },
    );
  for (const scope of history)
    meterSnapshots.push(
      await knowledgeCall(
        env,
        room,
        "knowledge.storage.snapshot",
        { role: "manager", principal },
        { scope: scope.id },
      ),
    );
  await storage.put(STORAGE_DELETION_KEY, {
    schema: 1,
    at: now,
    totals: await storageTotals(storage),
    agreements: await agreements(storage),
    acceptance: accepted,
    acceptanceHistory: await acceptanceHistory(storage),
    rows: await storageRows(storage),
    meterSnapshots,
  });
}
export async function storageDeletionSummary(storage: Reader) {
  const receipt = await storage.get(STORAGE_DELETION_KEY);
  if (
    (await storage.get(STORAGE_AGREEMENTS_KEY)) !== undefined &&
    receipt === undefined
  )
    throw fail();
  return receipt ?? null;
}

export async function storageBillingAlarm(
  storage: Storage,
  env: StorageBillingEnv,
  now: number,
): Promise<number | null> {
  const current = await acceptance(storage);
  if (!current) return null;
  const view = await storageBillingView(storage, env, now);
  const actual = await acceptance(storage);
  if (!actual || actual.withdrawnAt !== null || actual.agreement.endsAt <= now)
    return view.pendingSettlement ? now + 86_400_000 : null;
  const date = new Date(now),
    nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1);
  return Math.min(now + 86_400_000, nextMonth, current.agreement.endsAt);
}
