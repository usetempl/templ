import {
  BRAIN_STORAGE_PRICE,
  brainStorageEstimateCents,
  brainStorageTerms,
  type BrainStorageView,
} from "@templ/chat/brain-storage";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import type { StorageAcceptance } from "./brain-storage-billing";
import {
  KnowledgeError,
  readMeta,
  sha256Hex,
  writeMeta,
  type KnowledgeDb,
} from "./support-knowledge-schema";

const AUTHORIZED = "brain-storage-authorized-v1";
const unsigned = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const fail = () =>
  new KnowledgeError(
    503,
    "storage-unavailable",
    "Storage usage is unavailable. Try again later.",
  );

export function storageMonth(at: number) {
  if (!unsigned(at) || at > Date.UTC(9999, 0)) throw fail();
  const date = new Date(at);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth());
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1);
  return { month: date.toISOString().slice(0, 7), start, end };
}

export function retainedUploadBytes(db: KnowledgeDb): number {
  const value = db.sql
    .exec("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM kb_upload_bytes")
    .toArray()[0]?.bytes;
  if (!unsigned(value)) throw fail();
  return value;
}
export type StorageUploadGrant = { scope: string; documentSha256: string };

/** The Room supplies signed authority. Knowledge checks the final stored bytes. */
export function requireBrainUploadAdmission(
  db: KnowledgeDb,
  principal: string,
  addedBytes: number,
  grant: unknown,
  now: number,
  humanEditor = false,
) {
  const nextBytes = retainedUploadBytes(db) + addedBytes;
  if (!unsigned(addedBytes) || !unsigned(nextBytes)) throw fail();
  if (nextBytes <= BRAIN_STORAGE_PRICE.freeBytesPerWorkspace) return;
  const input = grant as StorageUploadGrant | null;
  const scope = readMeta(db, AUTHORIZED);
  if (!input || !scope || input.scope !== scope)
    throw new KnowledgeError(
      403,
      "storage-upload-not-authorized",
      "Extra file storage is not enabled. Remove a file or use a docs link.",
    );
  const record = billingAuthorization(db, scope);
  if (
    record.principal !== record.agreement.signedBy ||
    (humanEditor !== true && record.principal !== principal) ||
    record.agreement.documentSha256 !== input.documentSha256 ||
    record.acceptedAt > now ||
    record.agreement.endsAt <= now ||
    record.withdrawnAt !== null
  )
    throw new KnowledgeError(
      403,
      "storage-upload-not-authorized",
      "Review the current storage agreement before adding files.",
    );
}
/** Retained uploads remain removable when paid answer use is paused. */
export function brainUploadUseAllowed(
  db: KnowledgeDb,
  grant: unknown,
  now: number,
): boolean {
  if (retainedUploadBytes(db) <= BRAIN_STORAGE_PRICE.freeBytesPerWorkspace)
    return true;
  const scope = readMeta(db, AUTHORIZED);
  const input = grant as StorageUploadGrant | null;
  if (!scope || !input || input.scope !== scope) return false;
  const record = billingAuthorization(db, scope);
  return (
    record.agreement.documentSha256 === input.documentSha256 &&
    record.acceptedAt <= now &&
    now < record.agreement.endsAt &&
    record.withdrawnAt === null
  );
}

function checkpoint(db: KnowledgeDb, now: number) {
  const row = db.sql
    .exec("SELECT measured_at, bytes FROM kb_storage_meter WHERE id = 1")
    .toArray()[0];
  if (!row) {
    const bytes = retainedUploadBytes(db);
    db.sql.exec(
      "INSERT INTO kb_storage_meter (id, measured_at, bytes) VALUES (1, ?, ?)",
      now,
      bytes,
    );
    return { at: now, bytes };
  }
  if (
    !unsigned(row.measured_at) ||
    !unsigned(row.bytes) ||
    row.measured_at > now
  )
    throw fail();
  return { at: row.measured_at, bytes: row.bytes };
}
function byteMs(db: KnowledgeDb, month: string, scope: string): bigint {
  const row = db.sql
    .exec(
      "SELECT byte_ms FROM kb_storage_months WHERE month = ? AND scope = ?",
      month,
      scope,
    )
    .toArray()[0];
  if (!row) return 0n;
  if (typeof row.byte_ms !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.byte_ms))
    throw fail();
  return BigInt(row.byte_ms);
}
function addIntegral(
  db: KnowledgeDb,
  month: string,
  scope: string,
  amount: bigint,
) {
  db.sql.exec(
    "INSERT INTO kb_storage_months (month, scope, byte_ms) VALUES (?, ?, ?) ON CONFLICT (month, scope) DO UPDATE SET byte_ms = excluded.byte_ms",
    month,
    scope,
    (byteMs(db, month, scope) + amount).toString(),
  );
}

/** Call inside the same transaction as each retained-upload mutation. */
export function advanceBrainStorage(db: KnowledgeDb, now: number) {
  storageMonth(now);
  const previous = checkpoint(db, now);
  const authorizedId = readMeta(db, AUTHORIZED);
  const authorized = authorizedId
    ? billingAuthorization(db, authorizedId)
    : null;
  const billableBytes = Math.max(
    0,
    previous.bytes - BRAIN_STORAGE_PRICE.freeBytesPerWorkspace,
  );
  let from = previous.at;
  while (from < now) {
    const month = storageMonth(from);
    const until = Math.min(now, month.end);
    const amount = BigInt(billableBytes) * BigInt(until - from);
    addIntegral(db, month.month, "estimate", amount);
    if (authorized) {
      const untilAuthorized = Math.min(
        until,
        authorized.agreement.endsAt,
        authorized.withdrawnAt ?? until,
      );
      const fromAuthorized = Math.max(from, authorized.acceptedAt);
      if (untilAuthorized > fromAuthorized)
        addIntegral(
          db,
          month.month,
          authorized.id,
          BigInt(billableBytes) * BigInt(untilAuthorized - fromAuthorized),
        );
    }
    from = until;
  }
  db.sql.exec("UPDATE kb_storage_meter SET measured_at = ? WHERE id = 1", now);
}
export function syncBrainStorageBytes(db: KnowledgeDb) {
  db.sql.exec(
    "UPDATE kb_storage_meter SET bytes = ? WHERE id = 1",
    retainedUploadBytes(db),
  );
}

export async function brainStorageView(
  db: KnowledgeDb,
  now: number,
): Promise<BrainStorageView> {
  db.transaction(() => advanceBrainStorage(db, now));
  const month = storageMonth(now);
  const monthMs = month.end - month.start;
  const unclassifiedSources = db.sql
    .exec("SELECT COUNT(*) AS n FROM kb_sources WHERE origin = 'unclassified'")
    .toArray()[0]?.n;
  if (!unsigned(unclassifiedSources)) throw fail();
  const terms = brainStorageTerms();
  return {
    schema: 1,
    collectionQualified: false,
    retainedUploadBytes: retainedUploadBytes(db),
    unclassifiedSources,
    measuredAt: new Date(now).toISOString(),
    month: month.month,
    monthEndsAt: new Date(month.end).toISOString(),
    price: { ...BRAIN_STORAGE_PRICE },
    terms,
    termsSha256: await sha256Hex(terms),
    meteredEstimateCents: brainStorageEstimateCents(
      byteMs(db, month.month, "estimate").toString(),
      monthMs,
    ),
  };
}

function billingAuthorization(db: KnowledgeDb, id: string): StorageAcceptance {
  const raw = db.sql
    .exec("SELECT record FROM kb_storage_authorizations WHERE id = ?", id)
    .toArray()[0]?.record;
  let value: StorageAcceptance;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw fail();
  }
  if (
    value.schema !== 1 ||
    !/^bsc-[a-f0-9-]{36}$/.test(value.id) ||
    value.id !== id ||
    `room:${value.agreement?.workspace}` !== readMeta(db, "room") ||
    normalizeChatPrincipal(value.principal) !== value.principal ||
    !unsigned(value.acceptedAt) ||
    !unsigned(value.debtLimitCents) ||
    value.debtLimitCents === 0 ||
    value.debtLimitCents > 100_000 ||
    !unsigned(value.agreement?.endsAt) ||
    value.agreement.endsAt <= value.acceptedAt ||
    !/^[a-f0-9]{64}$/.test(value.agreement.documentSha256) ||
    JSON.stringify(value.agreement.price) !==
      JSON.stringify(BRAIN_STORAGE_PRICE) ||
    !(
      value.withdrawnAt === null ||
      (unsigned(value.withdrawnAt) && value.withdrawnAt >= value.acceptedAt)
    )
  )
    throw fail();
  return value;
}
export function storageAuthorizedManager(
  db: KnowledgeDb,
  now: number,
): string | null {
  const id = readMeta(db, AUTHORIZED);
  if (!id) return null;
  const record = billingAuthorization(db, id);
  return record.withdrawnAt === null &&
    record.acceptedAt <= now &&
    now < record.agreement.endsAt
    ? record.principal
    : null;
}
export function authorizeStorageBilling(
  db: KnowledgeDb,
  record: StorageAcceptance,
  now: number,
) {
  db.transaction(() => {
    const prior = db.sql
      .exec(
        "SELECT record FROM kb_storage_authorizations WHERE id = ?",
        record.id,
      )
      .toArray()[0]?.record;
    if (prior !== undefined) {
      const previous = billingAuthorization(db, record.id);
      if (
        JSON.stringify(previous.agreement) !==
          JSON.stringify(record.agreement) ||
        previous.principal !== record.principal ||
        previous.withdrawnAt !== null
      )
        throw fail();
      return;
    }
    if (
      record.acceptedAt > now ||
      record.withdrawnAt !== null ||
      record.principal !== record.agreement.signedBy
    )
      throw fail();
    const active = readMeta(db, AUTHORIZED);
    if (
      active &&
      billingAuthorization(db, active).withdrawnAt === null &&
      billingAuthorization(db, active).agreement.endsAt > now
    )
      throw fail();
    advanceBrainStorage(db, now);
    db.sql.exec(
      "INSERT INTO kb_storage_authorizations (id, record) VALUES (?, ?)",
      record.id,
      JSON.stringify(record),
    );
    billingAuthorization(db, record.id);
    writeMeta(db, AUTHORIZED, record.id);
  });
  return { record: billingAuthorization(db, record.id) };
}
export function stopStorageBilling(
  db: KnowledgeDb,
  scope: string,
  now: number,
) {
  return db.transaction(() => {
    const record = billingAuthorization(db, scope);
    if (record.withdrawnAt !== null) return { stoppedAt: record.withdrawnAt };
    advanceBrainStorage(db, now);
    db.sql.exec(
      "UPDATE kb_storage_authorizations SET record = ? WHERE id = ?",
      JSON.stringify({ ...record, withdrawnAt: now }),
      scope,
    );
    if (readMeta(db, AUTHORIZED) === scope)
      db.sql.exec("DELETE FROM meta WHERE key = ?", AUTHORIZED);
    return { stoppedAt: now };
  });
}
export function storageBillingSnapshot(
  db: KnowledgeDb,
  scope: string,
  now: number,
) {
  db.transaction(() => advanceBrainStorage(db, now));
  const record = billingAuthorization(db, scope);
  const months = db.sql
    .exec(
      "SELECT month, byte_ms FROM kb_storage_months WHERE scope = ? ORDER BY month",
      scope,
    )
    .toArray()
    .map((row) => {
      if (
        typeof row.month !== "string" ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)
      )
        throw fail();
      const at = Date.parse(`${row.month}-01T00:00:00Z`),
        period = storageMonth(at);
      return {
        month: row.month,
        byteMs: byteMs(db, row.month, scope).toString(),
        monthMs: period.end - period.start,
      };
    });
  return {
    scope,
    documentSha256: record.agreement.documentSha256,
    measuredAt: now,
    months,
  };
}
