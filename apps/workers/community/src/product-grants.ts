/** Reviewed grants: resolved cases Templ gives a named workspace, and the
 * operator grant that makes Templ's own workspace exempt.
 *
 * The list comes only from the `PRODUCT_GRANTS` policy var, which the deploy
 * passes from `v4-release.json` `productGrants` and `revokedProductGrants`
 * (`release-policy-vars.mjs` builds the text; the product-grants gate reviews
 * approval, dates and caps). Its shape is
 * `{"grants":[{id,kind,workspace,cases?,days,creditBy,extends?}],"revoked":[{id,revokedAt}]}`;
 * `cases` is absent exactly on the operator kind.
 *
 * Rules the worker keeps whatever the list says:
 * - An unreadable list does nothing: no credit and no revocation.
 * - A kind this worker does not know is skipped; the other entries still work.
 * - Absence never revokes. Only an id in `revoked` drops that grant's
 *   unused cases (reserved and used cases stay); an operator grant ends.
 * - A grant credits once, as `grant:<id>`. A revoked or re-listed id never
 *   credits again; a renewal needs a new id.
 * - Cases run from the credit for `days`. The founding credit's cases and
 *   days are PRODUCT_FOUNDING_CREDIT's, one per billing owner; every other
 *   case kind holds at most `grantMaxCases` per workspace, plus one entry
 *   that may go past it with `extends`.
 * - A grant credits only before the end of its `creditBy` day.
 * - Grants are not payments: never a receipt, never in the funnel's
 *   payment step. The first one marks `grant_credited`. */
import type { TemplStaffEnv } from "./templ-staff";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { PRODUCT_FOUNDING_CREDIT } from "@templ/chat/plans";
import {
  isProductGrantKind,
  type ProductGrantKind,
} from "@templ/chat/product-catalog";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError } from "./common";
import { markWorkspaceStep } from "./funnel-metrics";
import {
  GRANT_PAYMENT_PREFIX,
  PRODUCT_STATE_KEY,
  applyGrant,
  readProductState,
  recordProductEvent,
  revokeGrant,
  type ProductStorage,
} from "./product-entitlements";

export type ProductGrantsEnv = { PRODUCT_GRANTS?: string } & TemplStaffEnv;
export type ProductGrant = {
  id: string;
  kind: ProductGrantKind;
  /** `room:<workspace>` */
  room: string;
  /** Resolved cases held; 0 for the operator grant. */
  cases: number;
  days: number;
  /** Epoch ms: the end of the `creditBy` UTC day. */
  creditByEnd: number;
  /** An earlier grant of the same kind for the same workspace. */
  extends: string | null;
};
export type ProductGrantList =
  | {
      ok: true;
      grants: readonly ProductGrant[];
      revoked: ReadonlySet<string>;
    }
  | { ok: false };
export type GrantStatus = "pending" | "credited" | "deferred" | "revoked";

const DAY = 86_400_000;
const GRANT_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The room's own record of what each grant did. */
export const GRANT_LEDGER_KEY = "product-grants-v2";
/** Grants one workspace can have seen, credited or not. */
const LEDGER_ENTRIES = 64;
const NOTHING: ProductGrantList = { ok: true, grants: [], revoked: new Set() };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const whole = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
function day(value: unknown) {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (!match) return null;
  const at = Date.UTC(+match[1], +match[2] - 1, +match[3]);
  return new Date(at).toISOString().slice(0, 10) === value ? at : null;
}
/** Whether an entry's cases and days fit its kind. */
export function grantTermsValid(
  kind: ProductGrantKind,
  cases: unknown,
  days: unknown,
) {
  if (kind === "operator")
    return cases === undefined && whole(days, FEATURE_LIMITS.operatorMaxDays);
  if (kind === "founding")
    return (
      cases === PRODUCT_FOUNDING_CREDIT.cases &&
      days === PRODUCT_FOUNDING_CREDIT.days
    );
  return (
    whole(cases, FEATURE_LIMITS.grantMaxCases) &&
    whole(days, FEATURE_LIMITS.grantMaxDays)
  );
}

function parse(raw: string): ProductGrantList {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (
    !object(value) ||
    Object.keys(value).sort().join() !== "grants,revoked" ||
    !Array.isArray(value.grants) ||
    !Array.isArray(value.revoked) ||
    value.grants.length > FEATURE_LIMITS.grantListMaxEntries ||
    value.revoked.length > FEATURE_LIMITS.grantListMaxEntries
  )
    return { ok: false };
  const ids = new Set<string>();
  const grants: ProductGrant[] = [];
  for (const entry of value.grants) {
    if (
      !object(entry) ||
      typeof entry.id !== "string" ||
      !GRANT_ID.test(entry.id)
    )
      return { ok: false };
    if (ids.has(entry.id)) return { ok: false };
    ids.add(entry.id);
    // A kind a later release added: skip this entry, keep the others.
    if (!isProductGrantKind(entry.kind)) continue;
    const kind = entry.kind;
    const creditBy = day(entry.creditBy);
    const expected = [
      "creditBy",
      "days",
      "id",
      "kind",
      "workspace",
      ...(kind === "operator" ? [] : ["cases"]),
      ...(entry.extends === undefined ? [] : ["extends"]),
    ].sort();
    if (
      Object.keys(entry).sort().join() !== expected.join() ||
      typeof entry.workspace !== "string" ||
      !WORKSPACE.test(entry.workspace) ||
      !grantTermsValid(kind, entry.cases, entry.days) ||
      creditBy === null ||
      (entry.extends !== undefined &&
        (typeof entry.extends !== "string" ||
          !GRANT_ID.test(entry.extends) ||
          entry.extends === entry.id ||
          kind === "operator" ||
          kind === "founding"))
    )
      return { ok: false };
    grants.push({
      id: entry.id,
      kind,
      room: `room:${entry.workspace}`,
      cases: kind === "operator" ? 0 : (entry.cases as number),
      days: entry.days as number,
      creditByEnd: creditBy + DAY,
      extends: (entry.extends as string | undefined) ?? null,
    });
  }
  const revoked = new Set<string>();
  for (const entry of value.revoked) {
    if (
      !object(entry) ||
      Object.keys(entry).sort().join() !== "id,revokedAt" ||
      typeof entry.id !== "string" ||
      !GRANT_ID.test(entry.id) ||
      revoked.has(entry.id) ||
      day(entry.revokedAt) === null
    )
      return { ok: false };
    revoked.add(entry.id);
  }
  return { ok: true, grants: Object.freeze(grants), revoked };
}

let parsed: { raw: string; value: ProductGrantList } | null = null;
/** The reviewed list, parsed once per isolate for each value. An absent var
 * lists nothing. An unreadable one returns `{ ok: false }` and logs a fixed
 * label once per value, never the text. */
export function productGrants(env: ProductGrantsEnv): ProductGrantList {
  const raw = env.PRODUCT_GRANTS;
  if (raw === undefined || raw === "") return NOTHING;
  if (parsed?.raw !== raw) {
    parsed = { raw, value: parse(raw) };
    if (!parsed.value.ok) console.error("TEMPL_PRODUCT_GRANTS_INVALID");
  }
  return parsed.value;
}

type LedgerEntry = {
  kind: ProductGrantKind;
  cases: number;
  status: Exclude<GrantStatus, "pending">;
  extends: string | null;
  at: number;
  /** When the credited cases or the operator grant end. */
  endsAt: number | null;
};
type GrantLedger = { schema: 1; grants: Record<string, LedgerEntry> };
async function readLedger(
  storage: Pick<ProductStorage, "get">,
): Promise<GrantLedger> {
  const value = await storage.get<unknown>(GRANT_LEDGER_KEY);
  if (value === undefined) return { schema: 1, grants: {} };
  if (
    !object(value) ||
    value.schema !== 1 ||
    !object(value.grants) ||
    Object.keys(value.grants).length > LEDGER_ENTRIES ||
    Object.entries(value.grants).some(
      ([id, entry]) =>
        !GRANT_ID.test(id) ||
        !object(entry) ||
        !isProductGrantKind(entry.kind) ||
        !Number.isSafeInteger(entry.cases) ||
        !["credited", "deferred", "revoked"].includes(entry.status as string) ||
        !(entry.extends === null || typeof entry.extends === "string") ||
        !Number.isSafeInteger(entry.at) ||
        !(entry.endsAt === null || Number.isSafeInteger(entry.endsAt)),
    )
  )
    throw new HttpError(503, "Support plan status could not be verified.");
  return value as GrantLedger;
}

/** Cases of `kind` this workspace already holds from grants, and how many
 * came through `extends`. Revoked grants still count: removing a grant
 * never frees room for another. */
function kindUse(ledger: GrantLedger, kind: ProductGrantKind) {
  let cases = 0;
  let extensions = 0;
  for (const entry of Object.values(ledger.grants))
    if (
      entry.kind === kind &&
      (entry.status === "credited" || entry.status === "revoked")
    ) {
      if (entry.extends) extensions++;
      else cases += entry.cases;
    }
  return { cases, extensions };
}

/** Whether `grant` may credit under the per-kind cap, or why not. */
function capReason(ledger: GrantLedger, grant: ProductGrant) {
  if (grant.kind === "operator") return null;
  const use = kindUse(ledger, grant.kind);
  if (grant.kind === "founding") return use.cases > 0 ? "kind-cap" : null;
  if (grant.extends === null)
    return use.cases + grant.cases <= FEATURE_LIMITS.grantMaxCases
      ? null
      : "kind-cap";
  const earlier = ledger.grants[grant.extends];
  return earlier &&
    earlier.kind === grant.kind &&
    !earlier.extends &&
    (earlier.status === "credited" || earlier.status === "revoked") &&
    use.extensions < FEATURE_LIMITS.grantExtendsPerKind
    ? null
    : "kind-cap";
}

export type AppliedGrants = {
  credited: string[];
  deferred: string[];
  revoked: string[];
};
/** Asks the owner registry whether this workspace may hold its owner's
 * founding credit (one per billing owner). */
export type FoundingRegistry = (
  owner: ChatPrincipalId,
  room: string,
) => Promise<boolean>;

/** Applies the reviewed list to one room, inside its storage transaction,
 * after initializeProducts. Revocations run first, then credits. A per-kind
 * cap or an owner who already holds a founding credit defers a grant
 * without failing the request; any other error propagates so the request
 * fails closed. */
export async function applyProductGrants(
  storage: ProductStorage,
  env: ProductGrantsEnv,
  room: string,
  nowMs: number,
  founding?: FoundingRegistry,
): Promise<AppliedGrants> {
  const applied: AppliedGrants = { credited: [], deferred: [], revoked: [] };
  const list = productGrants(env);
  if (!list.ok) return applied;
  const mine = list.grants.filter((grant) => grant.room === room);
  if (!mine.length && !list.revoked.size) return applied;
  if (!(await storage.get(PRODUCT_STATE_KEY))) return applied;
  const state = await readProductState(storage, nowMs, env);
  const ledger = await readLedger(storage);
  let changed = false;

  // 1. Explicit revocations: the unused cases of each revoked grant.
  for (const id of list.revoked) {
    const entry = ledger.grants[id];
    if (!entry || entry.status !== "credited") continue;
    const dropped = revokeGrant(state, { id, kind: entry.kind });
    entry.status = "revoked";
    entry.at = state.asOf;
    if (entry.kind === "operator") entry.endsAt = state.asOf;
    changed = true;
    await recordProductEvent(storage, `grant-revoked:${id}`, {
      action: "grant.revoked",
      at: state.asOf,
      cases: dropped,
      grant: entry.kind,
    });
    applied.revoked.push(id);
  }

  // 2. Credits, in list order.
  for (const grant of mine) {
    if (list.revoked.has(grant.id)) continue;
    if (state.creditedPayments.includes(`${GRANT_PAYMENT_PREFIX}${grant.id}`))
      continue;
    if (state.asOf >= grant.creditByEnd) continue;
    if (
      Object.keys(ledger.grants).length >= LEDGER_ENTRIES &&
      !ledger.grants[grant.id]
    )
      continue;
    let reason = capReason(ledger, grant);
    if (
      !reason &&
      grant.kind === "founding" &&
      !(founding && (await founding(state.creator, state.room)))
    )
      reason = "owner-has-founding";
    if (reason) {
      if (ledger.grants[grant.id]?.status !== "deferred") {
        ledger.grants[grant.id] = {
          kind: grant.kind,
          cases: grant.cases,
          status: "deferred",
          extends: grant.extends,
          at: state.asOf,
          endsAt: null,
        };
        changed = true;
        await recordProductEvent(storage, `grant-deferred:${grant.id}`, {
          action: "grant.deferred",
          at: state.asOf,
          cases: grant.cases,
          reason,
          grant: grant.kind,
        });
      }
      applied.deferred.push(grant.id);
      continue;
    }
    applyGrant(state, grant);
    ledger.grants[grant.id] = {
      kind: grant.kind,
      cases: grant.cases,
      status: "credited",
      extends: grant.extends,
      at: state.asOf,
      endsAt: state.asOf + grant.days * DAY,
    };
    changed = true;
    applied.credited.push(grant.id);
    await recordProductEvent(storage, `grant:${grant.id}`, {
      action: "grant.credited",
      at: state.asOf,
      cases: grant.cases,
      grant: grant.kind,
    });
    await markWorkspaceStep(storage, "grant_credited", state.asOf);
  }
  if (changed) {
    await storage.put(PRODUCT_STATE_KEY, state);
    await storage.put(GRANT_LEDGER_KEY, ledger);
  }
  return applied;
}

/** What each listed grant for this room did, for `/operator/grants`: fixed
 * fields only, no usage and no names. Call after applyProductGrants. */
export async function grantStatuses(
  storage: Pick<ProductStorage, "get">,
  env: ProductGrantsEnv,
  room: string,
): Promise<
  {
    id: string;
    kind: ProductGrantKind;
    status: GrantStatus;
    cases: number;
    endsAt: string | null;
  }[]
> {
  const list = productGrants(env);
  if (!list.ok) throw new HttpError(503, "The grant list could not be read.");
  const mine = list.grants.filter((grant) => grant.room === room);
  if (!mine.length) return [];
  const ledger = (await storage.get(PRODUCT_STATE_KEY))
    ? await readLedger(storage)
    : ({ schema: 1, grants: {} } as GrantLedger);
  return mine.map((grant) => {
    const entry = ledger.grants[grant.id];
    const status: GrantStatus = list.revoked.has(grant.id)
      ? "revoked"
      : (entry?.status ?? "pending");
    return {
      id: grant.id,
      kind: grant.kind,
      status,
      cases: grant.cases,
      endsAt:
        entry?.endsAt != null ? new Date(entry.endsAt).toISOString() : null,
    };
  });
}
