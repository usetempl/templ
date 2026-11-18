import { HttpError, sha256Hex } from "./common";
import { isTrialOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import {
  approvedStorageTrialScope,
  type StorageTrialScope,
} from "./brain-storage-trial";
import type { NativeRoomRecord } from "./native-rooms";
import type { WorkspaceFlag } from "@templ/chat/workspace-flags";
import type { WorkspaceFlagEnv } from "./workspace-flags";
import {
  storageTotals,
  STORAGE_AGREEMENTS_KEY,
  type StorageAgreement,
} from "./brain-storage-billing";
const refuse = (): never => {
  throw new HttpError(404, "Not found.");
};
type Reader = { get<T = unknown>(key: string): Promise<T | undefined> };
type Environment = OperatorAdminEnv & WorkspaceFlagEnv;
export function storageTrialOperatorScope(
  env: Environment,
  actor: unknown,
  workspace: unknown,
  now: number,
) {
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    typeof actor !== "string" ||
    typeof workspace !== "string" ||
    !isTrialOperatorAdmin(env, actor as never, [actor])
  )
    return;
  const scope = approvedStorageTrialScope(
    env,
    workspace,
    undefined,
    undefined,
    now,
  );
  return scope?.operator === actor ? scope : undefined;
}
export async function assertStorageTrialWorkspace(
  storage: Reader,
  env: Environment,
  actor: unknown,
  workspace: unknown,
  now: number,
) {
  const scope = storageTrialOperatorScope(env, actor, workspace, now);
  if (!scope) return refuse();
  const native = await storage.get<NativeRoomRecord>("native-room"),
    product = await storage.get<{ creator?: unknown }>(
      "product-entitlements-v1",
    ),
    created = Date.parse(native?.room.createdAt ?? "");
  if (
    !native ||
    native.room.id !== scope.workspace ||
    native.room.creator !== scope.manager ||
    native.room.manager !== scope.manager ||
    !Number.isFinite(created) ||
    created > now ||
    (product && product.creator !== scope.manager) ||
    (await storage.get("workspace-deletion-v1")) !== undefined
  )
    return refuse();
  return scope;
}
export async function assertStorageTrialAction(
  storage: Reader,
  scope: StorageTrialScope,
  body: Record<string, unknown>,
) {
  if (body.action === "read") return;
  if (
    !scope.allowedActions.includes(String(body.action)) ||
    body.reason !== "Synthetic hosted storage verification"
  )
    return refuse();
  if (body.action === "record") {
    if (
      body.id !== scope.agreementId ||
      body.revision !== scope.revision ||
      body.signedBy !== scope.manager ||
      body.documentSha256 !== scope.documentSha256 ||
      body.termsSha256 !== scope.termsSha256 ||
      body.priceVersion !== scope.priceVersion ||
      body.startsAt !== scope.startsAt ||
      body.endsAt !== scope.endsAt
    )
      return refuse();
    return;
  }
  const history = await storage.get<{ history: StorageAgreement[] }>(
    STORAGE_AGREEMENTS_KEY,
  );
  if (
    !history?.history.some(
      (a) =>
        a.id === scope.agreementId &&
        a.revision === scope.revision &&
        a.workspace === scope.workspace &&
        a.signedBy === scope.manager &&
        a.approvedBy === scope.operator &&
        a.documentSha256 === scope.documentSha256 &&
        a.termsSha256 === scope.termsSha256 &&
        a.startsAt === scope.startsAt &&
        a.endsAt === scope.endsAt,
    )
  )
    return refuse();
  if (body.action === "end") {
    if (body.id !== scope.agreementId || body.revision !== scope.revision)
      return refuse();
    return;
  }
  const kind = body.action === "payment" ? "payment" : "credit";
  if (
    body.receiptId !== `storage-trial-${kind}` ||
    !Number.isSafeInteger(body.cents) ||
    Number(body.cents) < 1 ||
    Number(body.cents) > scope.debtLimitCents ||
    body.referenceSha256 !==
      (await sha256Hex(
        `Templ synthetic Brain trial ${scope.workspace} ${kind} ${body.receiptId}`,
      ))
  )
    return refuse();
  const totals = await storageTotals(storage),
    prior = await storage.get<{ cents: number }>(
      `brain-storage-row-v1:${kind}:${body.referenceSha256}`,
    );
  if (
    !prior &&
    totals.paidCents + totals.creditedCents + Number(body.cents) >
      scope.debtLimitCents
  )
    return refuse();
}

export async function currentStorageTrialFlags(
  storage: Reader,
  env: Environment,
  flags: Record<string, WorkspaceFlag>,
  native?: NativeRoomRecord,
  now = Date.now(),
) {
  if (!native) return flags;
  const keys = ["quality", "brainStorage"].filter(
    (key) =>
      flags[key]?.operator === "0x5498b97be0786c1de0166fd554fb55a091603e36" &&
      flags[key]?.reason === "Synthetic hosted storage verification",
  );
  if (!keys.length) return flags;
  try {
    await assertStorageTrialWorkspace(
      storage,
      env,
      flags[keys[0]].operator,
      native.room.id,
      now,
    );
    return flags;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
  }
  const next = { ...flags };
  for (const key of keys) delete next[key];
  return next;
}
