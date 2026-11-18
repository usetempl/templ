import type { NativeRoomRecord } from "./native-rooms";
import type { ProductOrderForm } from "./product-order-forms";
import { isMoneyFlag, type WorkspaceFlag } from "@templ/chat/workspace-flags";
import { HttpError } from "./common";
import { isTrialOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";

/** Broad delegated non-monetary test authority. It records no founder signature
 * or digest-specific founder review. Only the real bound trial manager accepts. */
export const MANAGED_QUALIFICATION_TRIAL = Object.freeze({
  workspace: "01a11f6f-6c2a-7fcf-a16d-fead49f3e6f6",
  manager: "0x352ec61c9641c4f79e35c3e9fa933211e13ad440",
  operator: "0x5498b97be0786c1de0166fd554fb55a091603e36",
  founder: "0x5b87102358a61bc9a6d32b20b121bbfd2a535c8d",
  documentSha256: "be87c16db6c0d181ae363da13b688b29a08b5f675b0d038f075f0a4e09a3200a",
  revision: 1,
  until: "2026-10-12T00:00:00.000Z",
  authorizationSha256: "7163dfc67809a0b66bfd6f9bea9be7b7778f3d815f4b0c6bc55c7858b68ffb0e",
  table: Object.freeze({ usdCents: 800, aiOnlyUsdCents: 99, stepOneAfterCases: 100, stepOneUsdCents: 400 }),
});
export const MANAGED_TRIAL_ACCEPTANCE_KEY = "managed-qualification-acceptance-v1";
type TrialEnv = OperatorAdminEnv & { APP_ORIGIN?: string; MANAGED_AGENT_ENABLED?: string };
type Reader = { get<T = unknown>(key: string): Promise<T | undefined> };
type Writer = Reader & { put(key: string, value: unknown): Promise<void> };
type Acceptance = { documentSha256: string; revision: number; manager: string; acceptedAt: number; revokedAt: number | null };
async function readAcceptance(storage: Reader): Promise<Acceptance | undefined> {
  const value = await storage.get<Acceptance>(MANAGED_TRIAL_ACCEPTANCE_KEY);
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "acceptedAt,documentSha256,manager,revision,revokedAt" ||
      value.documentSha256 !== MANAGED_QUALIFICATION_TRIAL.documentSha256 || value.manager !== MANAGED_QUALIFICATION_TRIAL.manager || value.revision !== 1 ||
      !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt < 0 ||
      !(value.revokedAt === null || (Number.isSafeInteger(value.revokedAt) && value.revokedAt >= value.acceptedAt)))
    throw new HttpError(503, "Trial acceptance is unavailable.");
  return value;
}
const trial = MANAGED_QUALIFICATION_TRIAL;
const refuse = (): never => { throw new HttpError(404, "Not found."); };
export function managedQualificationTrial(env: TrialEnv, actor: unknown, workspace: unknown, now = Date.now()) {
  return env.APP_ORIGIN === "https://usetempl.com" && env.MANAGED_AGENT_ENABLED === "true" &&
    actor === trial.operator && workspace === trial.workspace && now < Date.parse(trial.until) &&
    isTrialOperatorAdmin(env, trial.operator, [trial.operator]);
}
export async function assertManagedQualificationWorkspace(storage: Reader, env: TrialEnv, actor: unknown, now: number, allowRevoked = false) {
  const native = await storage.get<NativeRoomRecord>("native-room");
  const created = Date.parse(native?.room.createdAt ?? "");
  const product = await storage.get<{ creator?: unknown }>("product-entitlements-v1");
  const flags = await storage.get<Record<string, WorkspaceFlag>>("workspace-flags-v1");
  const acceptance = await readAcceptance(storage);
  if (!managedQualificationTrial(env, actor, native?.room.id, now) ||
      native?.room.creator !== trial.manager || native.room.manager !== trial.manager ||
      native.trialOperator !== trial.operator || !Number.isFinite(created) || created > now ||
      (product && product.creator !== trial.manager) ||
      Object.entries(flags ?? {}).some(([key, flag]) => flag.on && isMoneyFlag(key as never)) ||
      (acceptance?.revokedAt !== null && acceptance?.revokedAt !== undefined && !allowRevoked) ||
      (await storage.get("workspace-deletion-v1")) !== undefined) refuse();
}
export async function acceptManagedQualification(storage: Writer, env: TrialEnv, manager: unknown, value: unknown, now: number) {
  await assertManagedQualificationWorkspace(storage, env, trial.operator, now);
  if (manager !== trial.manager || !value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "documentSha256,revision" ||
      (value as Acceptance).documentSha256 !== trial.documentSha256 || (value as Acceptance).revision !== trial.revision) refuse();
  const existing = await readAcceptance(storage);
  if (existing && (existing.documentSha256 !== trial.documentSha256 || existing.revision !== trial.revision || existing.manager !== trial.manager || existing.revokedAt !== null)) refuse();
  if (!existing) await storage.put(MANAGED_TRIAL_ACCEPTANCE_KEY, { documentSha256: trial.documentSha256, revision: trial.revision, manager: trial.manager, acceptedAt: now, revokedAt: null });
}
export async function assertManagedQualificationForm(storage: Reader, form: Partial<ProductOrderForm>, now: number, allowRevoked = false) {
  const consent = await readAcceptance(storage);
  if (form.workspace !== `room:${trial.workspace}` || form.service !== "managed-ai" ||
      form.documentSha256 !== trial.documentSha256 || form.revision !== 1 ||
      form.approvedBy !== trial.founder || form.createdBy !== trial.operator ||
      form.endsAt !== Date.parse(trial.until) || form.usage !== undefined || form.pilot !== undefined ||
      Object.entries(trial.table).some(([key, value]) => form.table?.[key as keyof typeof trial.table] !== value) ||
      !consent || consent.documentSha256 !== trial.documentSha256 || consent.revision !== 1 || consent.manager !== trial.manager ||
      (!allowRevoked && consent.revokedAt !== null) || !Number.isSafeInteger(consent.acceptedAt) || consent.acceptedAt > now ||
      !Number.isSafeInteger(form.startsAt) || form.startsAt! < consent.acceptedAt) refuse();
}
export async function revokeManagedQualification(storage: Writer, now: number) {
  const acceptance = await readAcceptance(storage);
  await storage.put(MANAGED_TRIAL_ACCEPTANCE_KEY, { documentSha256: trial.documentSha256, revision: 1, manager: trial.manager, acceptedAt: acceptance?.acceptedAt ?? now, revokedAt: acceptance?.revokedAt ?? now });
}
export async function currentManagedQualificationFlags(storage: Reader, env: TrialEnv, flags: Record<string, WorkspaceFlag>, native: NativeRoomRecord | undefined, now: number) {
  if (native?.room.id !== trial.workspace || !flags.managedAgent) return flags;
  const acceptance = await readAcceptance(storage);
  if (managedQualificationTrial(env, flags.managedAgent.operator, native.room.id, now) &&
      native.room.creator === trial.manager && native.room.manager === trial.manager && native.trialOperator === trial.operator &&
      (acceptance?.revokedAt === null || acceptance?.revokedAt === undefined) && Date.parse(flags.managedAgent.until) <= Date.parse(trial.until)) return flags;
  const result = { ...flags }; delete result.managedAgent; return result;
}
