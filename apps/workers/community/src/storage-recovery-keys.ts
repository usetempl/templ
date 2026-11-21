/** Room state a storage restore does not simply roll back to T.
 *
 * A point-in-time restore brings the whole room object back to T. Most of
 * it is support history and goes back with the messages. Prepaid charge
 * history returns with its cases. Manual receivables and payment records
 * stay current. The records below do not roll back, because that
 * would lose a verified payment, switch AI back on, or send alerts to a
 * destination the manager removed:
 * - Kept: counters, pacing windows, quotas, checkout requests with their
 *   receipts, payments Templ reviewed, and priority settings, wallet proofs
 *   and verified positions. The value right before the restore wins,
 *   including its absence. The product state is merged
 *   instead: receipts and operator credits missing at T credit again, once,
 *   and an operator's suspension stays (`reconcileProductAfterRestore`).
 * - Off wins: a switch or preference stored as `{ enabled }` stays off when
 *   either timeline turned it off.
 * - Both: an alert destination stays only when both timelines hold it, with
 *   the settings it had right before the restore.
 * - Cleared: single-use links, socket tickets and pending priority reads
 *   end at a restore. Used links and in-flight reads cannot run again.
 *
 * Every other room record is restored with the history
 * (the recovery tests cover the retained financial and access records). */
import {
  CHARGE_PREFIX,
  readCharge,
  recoveryManualCharge,
  reconcileManualCharges,
  type Charge,
} from "./product-charges";
import type { TemplStaffEnv } from "./templ-staff";
import { HttpError } from "./common";
import {
  DEST_INDEX_KEY,
  DEST_PREFIX,
  checkedDestination,
  indexEntry,
} from "./alert-destinations";
import { deleteDestinationData } from "./alert-outbox";
import { reconcileProductAfterRestore } from "./product-billing";
import { PRODUCT_STATE_KEY } from "./product-entitlements";
import {
  endPriorityCaptureAfterRestore,
  type PriorityCaptureEnv,
} from "./priority-trial-capture";

type Tx = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;
type OutboxTx = Parameters<typeof deleteDestinationData>[0];

/** Kept exactly as they were right before the restore. */
export const RECOVERY_KEPT_KEYS = Object.freeze([
  // Current admission, pinned profile and consumed setup approvals are authority.
  // Restore must preserve their exact current value, including absence.
  "support-encryption-policy-v1",
  "support-encryption-own-setup-v1",
  "support-encryption-own-setup-release-v1",
  "support-encryption-access-revision-v1",
  "support-encryption-own-authority-checkpoint-v1",
  "support-encryption-own-qualification-v1",
  "support-encryption-deletion-revision-v1",
  "support-encryption-opening-fence-count-v1",
  // An authorized demo recovery never grants an Admin role twice.
  "demo-admin-recovery-v1",
  // Trial grants cannot be used again after a restore within their first minute.
  "workspace-own-trial-issuers-v1",
  "workspace-own-trial-used-v1",
  "workspace-demo-flag-revocations-v1",
  // Pairing approval and its revocation are current authority, not history.
  // An absent current pairing must not return from an earlier bookmark.
  "support-native-telegram-v1",
  // The product state: merged, not replaced (see above).
  "product-entitlements-v1",
  "product-standard-plan-v1",
  "product-starter-available-v1",
  "product-starter-ai-limit-v1",
  "product-standard-debt-access-v1",
  "product-standard-monthly-debt-v1",
  "product-prepaid-account-v1",
  "product-prepaid-ai-pending-v1",
  // Proven billing identities keep the key that names them.
  "product-billing-key-v1",
  // Checkout intents and their receipts.
  "product-payment-intents-v1",
  // The latest signed card state stays current across a room restore.
  "product-stripe-room-v1",
  // The card owner record stays current so no invoice is opened twice.
  "product-stripe-owner-v1",
  // Index revisions move past writes already acknowledged outside the room.
  "workspace-flags-index-revision-v1",
  // Revoked scoped grants stay revoked after an older restore.
  "workspace-scoped-flag-revocations-v1",
  // Signed forms and delivered notices keep their current prices and service limits.
  "product-order-form-v1",
  "product-usage-access-v1",
  "product-usage-totals-v1",
  "product-manual-totals-v1",
  // A withdrawn managed trial cannot resume through an older restore.
  "managed-qualification-acceptance-v1",
  // Knowledge meters and external payment claims stay current outside the room.
  "brain-storage-agreements-v1",
  "brain-storage-totals-v1",
  "brain-storage-acceptance-v1",
  "brain-storage-acceptance-history-v1",
  "brain-storage-deletion-receipt-v1",
  // Bytes of support screenshots stored: the files after T stay stored.
  "support-media-bytes-v1",
  "support-diagnosis-quota-v1",
  // Priority reads use the manager's current contracts and thresholds.
  "support-priority-settings-v1",
  "pilot-metrics-rate-v1",
  "reaction-rate-v1",
  "conversation-opens-v1",
  "conversation-guest-opens-v1",
  "private-invite-admissions-v1",
  // The finance address: one removed after T stays removed.
  "product-finance-email-v1",
  // The improvement copy's ref and pseudonym key: rows built after T stay
  // findable, so a privacy request can still delete them.
  "support-corpus-key-v1",
  // Learned FAQ provenance remains findable after a restore.
  "support-handoff-learning-key-v1",
] as const);
export const RECOVERY_KEPT_PREFIXES = Object.freeze([
  // Native encryption approvals never regain an earlier access generation.
  "support-encryption-access-v1:",
  "support-encryption-own-device-revoked-v1:",
  // A restore cannot reopen a delivered AI draft or reset its question cap.
  "support-encryption-own-ai-v1:",
  "support-ai-clarification-v1:",
  "support-encryption-opening-fence-v1:",
  // Accepted/fenced delivery decisions survive a rollback of message history.
  "support-encrypted-outcome-v1:",
  // A pruned encrypted case cannot return from a pre-deletion history image.
  // Only its opaque case reference remains, never keys, content or outcomes.
  "support-encrypted-deleted-v1:",
  "recovery-cancelled-v1:",
  // Keep relay restrictions and the exact current delivery intent, including
  // completed jobs' absence. A restore must not replay an old pairing or handoff.
  "support-native-telegram-grant-v1:",
  "support-native-telegram-outbox-v1:",
  "support-native-telegram-failed-v1:",
  // Opaque provenance still reaches generated knowledge after a restore.
  "support-handoff-learning-source-v1:",
  "support-handoff-learning-cleanup-v1:",
  "support-handoff-learning-index-members-v1:",
  "product-billing-identity-v1:",
  "product-usage-case-v1:",
  "product-standard-period-v1:",
  "product-standard-monthly-debt-v1:",
  "product-standard-reference-v1:",
  "product-standard-case-v1:",
  "product-standard-due-v1:",
  "product-standard-verified-access-v1:",
  "product-standard-usage-review-v1:",
  "product-prepaid-period-v1:",
  "product-prepaid-credit-v1:",
  "product-prepaid-debit-v1:",
  "product-prepaid-attempt-v1:",
  "product-prepaid-mode-v1:",
  "product-prepaid-answered-v1:",
  "product-prepaid-usage-v1:",
  "product-prepaid-ai-envelope-v1:",
  "product-prepaid-ai-circuit-v1:",
  "product-usage-case-row-v1:",
  "product-usage-month-v1:",
  "product-usage-auto-credit-month-v1:",
  "product-usage-dispute-v1:",
  "product-usage-row-v1:",
  "product-usage-entry-v1:",
  "product-usage-due-v1:",
  "product-manual-row-v1:",
  "product-manual-pending-v1:",
  "product-manual-agreement-v1:",
  "product-manual-month-v1:",
  "product-manual-posted-v1:",
  "product-manual-closing-v1:",
  "brain-storage-row-v1:",
  "brain-storage-month-v1:",
  "product-payment-intent-v1:",
  "product-payment-registration-v1:",
  // Accepted final usage and credits keep their durable delivery intent.
  "product-stripe-outbox-v1:",
  "product-stripe-coverage-v1:",
  // Owner updates and deleted-workspace cleanup still reach Stripe once.
  "product-stripe-owner-outbox-v1:",
  "stripe-invoice-reasons-v1:",
  "stripe-invoice-reason-case-v1:",
  "stripe-invoice-reason-outbox-v1:",
  "stripe-invoice-reason-audit-v1:",
  "product-order-form-staff-alert-v1:",
  "product-order-form-sequence-v1:",
  // Pilot cap use stays current so a restore never reopens cap room.
  "product-pilot-usage-v1:",
  // Templ classification remains on revoked grants after a restore.
  "templ-staff-v1:",
  "native-stripe-cleanup-v1:",
  "support-position-quota-v1:",
  // Verified wallet proofs and position checks keep their latest values.
  // A proof or position deleted after T stays deleted.
  "support-priority-position-v1:",
  "support-priority-proof-v1:",
  "support-eval-rate-v1:",
  "workspace-export-starts-v1:",
  "alert-creates-v1:",
  "alert-day-v1:",
  // Payments that didn't match their request and what Templ did with them.
  "product-unmatched-v1:",
  // Finance emails queued and monthly emails sent: a restore sends
  // neither again.
  "product-finance-out-v1:",
  "product-month-report-v1:",
  // A member's objection and a privacy deletion of the copy made after T,
  // and the member index of rows built after T, so those rows stay
  // deletable on the member's request.
  "support-corpus-objection-v1:",
  "support-corpus-skip-v1:",
  "support-corpus-member-v1:",
] as const);
/** Off when either timeline turned them off. */
export const RECOVERY_OFF_KEYS = Object.freeze([
  "managed-agent-v1",
  "support-ai-transactions-v1",
] as const);
export const RECOVERY_OFF_PREFIXES = Object.freeze([
  "support-alert-preference-v1:",
] as const);
/** Ended at a restore. */
export const RECOVERY_CLEARED_PREFIXES = Object.freeze([
  "support-priority-trial-capture-v1",
  "support-priority-trial-capture-row-v1:",
  // A restored invitation or hash index cannot revive a used or revoked link.
  "team-invite-v1:",
  "team-admin-invite-v1:",
  "team-invite-hash-v1:",
  "alert-ticket-v1:",
  "alert-ticket-of-v1:",
  "alert-grant-v1:",
  "realtime-ticket-v1:",
  "support-priority-pending-v1:",
  "support-priority-lease-v1:",
  // A restored marker or claimed model call must never run again.
  "support-handoff-learning-marker-v1:",
  "support-handoff-learning-job-v1:",
] as const);

export type RecoveryKeptState = {
  /** Kept records right before the restore, by key. */
  kept: Record<string, unknown>;
  /** Switches and preferences that were off right before the restore. */
  off: Record<string, unknown>;
  /** Alert destinations right before the restore, by key. */
  destinations: Record<string, unknown>;
};
export type KeptCounts = {
  keptRecords: number;
  offKept: number;
  destinationsRemoved: number;
  linksEnded: number;
};

/** Read one page at a time. Financial history has no recovery row limit. */
async function* scan(
  storage: Pick<Tx, "list">,
  prefix: string,
): AsyncGenerator<[string, unknown]> {
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<unknown>({
      prefix,
      limit: 500,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, value] of page) {
      startAfter = key;
      yield [key, value];
    }
    if (page.size < 500) return;
  }
}
const isOff = (value: unknown) =>
  Boolean(value) &&
  typeof value === "object" &&
  (value as { enabled?: unknown }).enabled === false;

export type RecoveryKeptGroup = "kept" | "off" | "destinations";
export type RecoveryKeptEntry = [RecoveryKeptGroup, string, unknown];
export type RecoveryKeptReader = {
  get(group: RecoveryKeptGroup, key: string): Promise<unknown>;
  entries(group: RecoveryKeptGroup): AsyncIterable<[string, unknown]>;
};

/** Snapshot entries share the access snapshot's transaction. */
export async function* keptEntries(
  storage: Pick<Tx, "get" | "list">,
): AsyncGenerator<RecoveryKeptEntry> {
  for (const key of RECOVERY_KEPT_KEYS) {
    const value = await storage.get<unknown>(key);
    if (value !== undefined) yield ["kept", key, value];
  }
  for (const prefix of RECOVERY_KEPT_PREFIXES)
    for await (const [key, value] of scan(storage, prefix))
      yield ["kept", key, value];
  for await (const [key, value] of scan(storage, CHARGE_PREFIX)) {
    if (!recoveryManualCharge(key, value)) continue;
    const charge = await readCharge(storage, value.thread, value.seq);
    if (!charge || !recoveryManualCharge(key, charge))
      throw new HttpError(503, "The case price could not be checked.");
    yield ["kept", key, charge];
  }
  for (const key of RECOVERY_OFF_KEYS) {
    const value = await storage.get<unknown>(key);
    if (isOff(value)) yield ["off", key, value];
  }
  for (const prefix of RECOVERY_OFF_PREFIXES)
    for await (const [key, value] of scan(storage, prefix))
      if (isOff(value)) yield ["off", key, value];
  for await (const [key, value] of scan(storage, DEST_PREFIX))
    yield ["destinations", key, value];
}

/** Inline snapshots remain readable for an in-progress restore. */
export async function takeKeptState(
  storage: Pick<Tx, "get" | "list">,
): Promise<RecoveryKeptState> {
  const state: RecoveryKeptState = { kept: {}, off: {}, destinations: {} };
  for await (const [group, key, value] of keptEntries(storage))
    state[group][key] = value;
  return state;
}

export function inlineKeptReader(state: RecoveryKeptState): RecoveryKeptReader {
  return {
    async get(group, key) {
      return state[group][key];
    },
    async *entries(group) {
      yield* Object.entries(state[group]);
    },
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keptKey = (key: string) =>
  (RECOVERY_KEPT_KEYS as readonly string[]).includes(key) ||
  RECOVERY_KEPT_PREFIXES.some((prefix) => key.startsWith(prefix));
const offKey = (key: string) =>
  (RECOVERY_OFF_KEYS as readonly string[]).includes(key) ||
  RECOVERY_OFF_PREFIXES.some((prefix) => key.startsWith(prefix));

/** A stored kept state, or an error: nothing outside the lists is written. */
export function checkedKeptState(value: unknown): RecoveryKeptState {
  if (
    !record(value) ||
    !record(value.kept) ||
    !record(value.off) ||
    !record(value.destinations) ||
    !Object.entries(value.kept).every(
      ([key, entry]) => keptKey(key) || recoveryManualCharge(key, entry),
    ) ||
    !Object.entries(value.off).every(
      ([key, entry]) => offKey(key) && isOff(entry),
    ) ||
    !Object.keys(value.destinations).every((key) => key.startsWith(DEST_PREFIX))
  )
    throw new HttpError(400, "Invalid access snapshot.");
  return value as RecoveryKeptState;
}

/** After a restore to T, inside the reconcile transaction. */
export async function reconcileKeptState(
  storage: Tx,
  state: RecoveryKeptState,
  env: TemplStaffEnv = {},
  source: RecoveryKeptReader = inlineKeptReader(state),
): Promise<KeptCounts> {
  await endPriorityCaptureAfterRestore(storage, env as PriorityCaptureEnv);
  const counts: KeptCounts = {
    keptRecords: 0,
    offKept: 0,
    destinationsRemoved: 0,
    linksEnded: 0,
  };
  // Kept: the values right before the restore, and nothing T held besides.
  const manualBefore = new Map<string, Charge>();
  const removeIfAbsent = async (key: string) => {
    if (
      key !== PRODUCT_STATE_KEY &&
      (await source.get("kept", key)) === undefined
    )
      await storage.delete(key);
  };
  for (const key of RECOVERY_KEPT_KEYS) await removeIfAbsent(key);
  for (const prefix of RECOVERY_KEPT_PREFIXES)
    for await (const [key] of scan(storage, prefix)) await removeIfAbsent(key);
  for await (const [key, value] of scan(storage, CHARGE_PREFIX)) {
    if ((value as Charge | null)?.collection === "manual") {
      const charge = await readCharge(
        storage,
        (value as Charge).thread,
        (value as Charge).seq,
      );
      if (!charge)
        throw new HttpError(503, "The case price could not be checked.");
      manualBefore.set(key, charge);
    }
    if (recoveryManualCharge(key, value)) await removeIfAbsent(key);
  }
  for await (const [key, value] of source.entries("kept")) {
    if (key !== PRODUCT_STATE_KEY) await storage.put(key, value);
    counts.keptRecords++;
  }
  // Once the receipts are back: merge the product state.
  const currentProduct = await source.get("kept", PRODUCT_STATE_KEY);
  if (currentProduct !== undefined)
    await reconcileProductAfterRestore(
      storage,
      currentProduct,
      Date.now(),
      env,
    );
  await reconcileManualCharges(
    storage as DurableObjectTransaction,
    manualBefore,
    env,
  );
  // Off wins.
  for await (const [key, value] of source.entries("off"))
    if (!isOff(await storage.get(key))) {
      await storage.put(key, value);
      counts.offKept++;
    }
  // Alert destinations: in both timelines, with the latest settings.
  let destinationCount = 0;
  const index = [];
  for await (const [key] of scan(storage, DEST_PREFIX)) {
    destinationCount++;
    const latest = checkedDestination(
      await source.get("destinations", key),
      key.slice(DEST_PREFIX.length),
    );
    if (!latest) {
      await deleteDestinationData(
        storage as OutboxTx,
        key.slice(DEST_PREFIX.length),
      );
      counts.destinationsRemoved++;
      continue;
    }
    await storage.put(key, latest);
    index.push(indexEntry(latest));
  }
  if (destinationCount || (await storage.get(DEST_INDEX_KEY)) !== undefined)
    await storage.put(DEST_INDEX_KEY, index);
  // Single-use links, socket tickets and pending priority reads.
  for (const prefix of RECOVERY_CLEARED_PREFIXES) {
    let keys: string[] = [];
    for await (const [key] of scan(storage, prefix)) {
      keys.push(key);
      counts.linksEnded++;
      if (keys.length === 128) {
        await storage.delete(keys);
        keys = [];
      }
    }
    if (keys.length) await storage.delete(keys);
  }
  return counts;
}
