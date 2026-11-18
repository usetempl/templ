import { normalizeChatPrincipal } from "@templ/chat/principal";
import { HttpError, type Env } from "./common";
import { isTrialOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import type { NativeRoomRecord } from "./native-rooms";
import { standardPlanView } from "./product-standard-plan";
import type { WorkspaceFlagEnv } from "./workspace-flags";
import { readProductState } from "./product-entitlements";
import { readProductOrderForms } from "./product-order-forms";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { servicePrincipals } from "./service-principals";
import { botsFromSettings, aiRole } from "./bots";
import { currentStaffRoleIds } from "./templ-staff";
import { PRODUCT_STANDARD_QUALIFICATION_PRICES } from "@templ/chat/plans";
import type { StandardPlanPeriod } from "@templ/chat/standard-plan";
import { releaseSourceIdentity } from "./release-identity";

/** This fixed noncash scope uses the captured release identity. It grants no operator role. */
export const STANDARD_MONTHLY_TRIAL = Object.freeze({
  workspace: "01a139e8-7ca0-731b-9890-9847a4d81c15",
  manager: "0xd26a957243a5ce9961f89dc1e2926f6e2623a769",
  operator: "0x5498b97be0786c1de0166fd554fb55a091603e36",
  founder: "0x5b87102358a61bc9a6d32b20b121bbfd2a535c8d",
  syntheticAiPrincipal: "0x2903395b8b4574f1835318e6a40d8e245c93184f",
  startsAt: "2026-10-14T10:15:00.000Z",
  until: "2026-10-18T00:00:00.000Z",
  referenceSha256:
    "a40f7e374f4bc234a3dc399d20a9abe1748267427b5f8b878d5d35bacf071e8f",
  reason: "Synthetic monthly-plan proof. First-month noncash access only.",
});
type TrialEnv = OperatorAdminEnv &
  WorkspaceFlagEnv &
  Partial<
    Pick<Env, "STANDARD_MONTHLY_TRIAL_AUTHORIZATION" | "RELEASE_IDENTITY">
  >;
type Reader = Pick<DurableObjectTransaction, "get">;
const refuse = (): never => {
  throw new HttpError(404, "Not found.");
};

/** Eligibility applies only to the fixed POST. GET and every other operator endpoint stay closed. */
export function standardMonthlyTrialSourceAdmitted(
  env: TrialEnv,
  workspace: unknown,
  now = Date.now(),
): boolean {
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    env.PRODUCT_MANUAL_BILLING_ENABLED !== "true" ||
    workspace !== STANDARD_MONTHLY_TRIAL.workspace ||
    now < Date.parse(STANDARD_MONTHLY_TRIAL.startsAt) ||
    now >= Date.parse(STANDARD_MONTHLY_TRIAL.until)
  )
    return false;
  try {
    const seal = JSON.parse(env.STANDARD_MONTHLY_TRIAL_AUTHORIZATION ?? "null"),
      identity = releaseSourceIdentity(env);
    return Boolean(
      seal &&
      identity &&
      Object.keys(seal).sort().join() ===
        "schemaVersion,scopeReferenceSha256" &&
      seal.schemaVersion === 1 &&
      seal.scopeReferenceSha256 === STANDARD_MONTHLY_TRIAL.referenceSha256 &&
      identity.schemaVersion === 1 &&
      identity.environment === "production" &&
      String(env.FOUNDER_PRINCIPALS ?? "")
        .split(",")
        .some(
          (value) =>
            normalizeChatPrincipal(value.trim()) ===
            STANDARD_MONTHLY_TRIAL.founder,
        ),
    );
  } catch {
    return false;
  }
}

export function standardMonthlyTrialEligible(
  env: TrialEnv,
  actor: unknown,
  workspace: unknown,
  now = Date.now(),
): boolean {
  const principal = normalizeChatPrincipal(actor);
  return (
    principal === STANDARD_MONTHLY_TRIAL.operator &&
    isTrialOperatorAdmin(env, principal, [principal]) &&
    standardMonthlyTrialSourceAdmitted(env, workspace, now)
  );
}

export function standardMonthlyTrialSourceSeal(env: TrialEnv) {
  const identity = releaseSourceIdentity(env);
  if (!identity || identity.environment !== "production") return refuse();
  return {
    scopeReferenceSha256: STANDARD_MONTHLY_TRIAL.referenceSha256,
    sourceCommit: identity.commit,
    sourceDigest: identity.sourceDigest,
  };
}

/** The edge's trusted identity must match this object's own runtime in the grant transaction. */
export function assertStandardMonthlyTrialSource(
  env: TrialEnv,
  expected: unknown,
) {
  if (
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    Object.keys(expected).sort().join() !==
      "scopeReferenceSha256,sourceCommit,sourceDigest" ||
    Object.entries(standardMonthlyTrialSourceSeal(env)).some(
      ([key, value]) => (expected as Record<string, unknown>)[key] !== value,
    )
  )
    refuse();
}

/** Exact body comparison rejects cash, debt, ownership, flags and caller-supplied internal authority. */
export function assertStandardMonthlyTrialAction(
  body: Record<string, unknown>,
) {
  const expected = {
    action: "standard-access",
    source: "founder-approved",
    approvedBy: STANDARD_MONTHLY_TRIAL.founder,
    referenceSha256: STANDARD_MONTHLY_TRIAL.referenceSha256,
    expectedPeriod: null,
    expectedPrincipalId: STANDARD_MONTHLY_TRIAL.operator,
    confirmed: true,
    reason: STANDARD_MONTHLY_TRIAL.reason,
  };
  if (
    Object.keys(body).sort().join() !== Object.keys(expected).sort().join() ||
    Object.entries(expected).some(([key, value]) => body[key] !== value)
  )
    refuse();
}

/** Native ownership and unfunded state are rechecked inside the same room transaction. */
async function cleanStandardMonthlyTrialWorkspace(
  storage: Reader,
  env: TrialEnv,
  now: number,
) {
  const native = await storage.get<NativeRoomRecord>("native-room"),
    product = await storage.get<{ creator?: unknown }>(
      "product-entitlements-v1",
    );
  const createdAt = Date.parse(native?.room.createdAt ?? "");
  if (
    !native ||
    native.room.id !== STANDARD_MONTHLY_TRIAL.workspace ||
    native.room.creator !== STANDARD_MONTHLY_TRIAL.manager ||
    native.room.manager !== STANDARD_MONTHLY_TRIAL.manager ||
    native.room.pendingManager != null ||
    native.trialOperator !== STANDARD_MONTHLY_TRIAL.operator ||
    !Number.isFinite(createdAt) ||
    createdAt < Date.parse(STANDARD_MONTHLY_TRIAL.startsAt) ||
    createdAt > now ||
    product?.creator !== STANDARD_MONTHLY_TRIAL.manager ||
    (await storage.get("workspace-deletion-v1")) !== undefined
  )
    return false;
  const legacy = await readProductState(storage, now, env);
  return (
    legacy.balanceCents === 0 &&
    legacy.pendingCents === 0 &&
    legacy.creditBaseCents === 0 &&
    legacy.credits === 0 &&
    !legacy.everFunded &&
    !legacy.cardCoverage &&
    legacy.exemptUntil === null &&
    legacy.grants.length === 0 &&
    legacy.creditedPayments.length === 0 &&
    legacy.suspended === null &&
    (await readProductOrderForms(storage)).history.length === 0
  );
}

/** The first grant is once-only. It cannot replace funded or retained legacy access. */
export async function assertStandardMonthlyTrialWorkspace(
  storage: Reader,
  env: TrialEnv,
  actor: unknown,
  workspace: string,
  now: number,
) {
  if (
    !standardMonthlyTrialEligible(env, actor, workspace, now) ||
    !(await cleanStandardMonthlyTrialWorkspace(storage, env, now))
  )
    refuse();
  const plan = await standardPlanView(storage, now);
  if (plan.period !== null || plan.chargedCents !== 0 || plan.paidCents !== 0)
    refuse();
}

/** Scripted fee qualification uses one registered producer. It proves no hosted model or service. */
export async function standardMonthlySyntheticPrincipal(
  room: string,
  aliases: readonly ChatPrincipalId[],
  context: {
    env: TrialEnv;
    storage: Reader;
    principalId: ChatPrincipalId | null;
    permissions: readonly string[];
    isBot: boolean;
    now: number;
  },
): Promise<ChatPrincipalId | null> {
  const workspace = room.replace(/^room:/, "");
  if (
    !standardMonthlyTrialSourceAdmitted(context.env, workspace, context.now) ||
    !context.isBot ||
    !context.permissions.includes("handleConversations")
  )
    return null;
  const verified = servicePrincipals(context.principalId, aliases);
  if (
    !verified.includes(STANDARD_MONTHLY_TRIAL.syntheticAiPrincipal) ||
    !(await cleanStandardMonthlyTrialWorkspace(
      context.storage,
      context.env,
      context.now,
    ))
  )
    return null;
  return botsFromSettings(await context.storage.get("chat-settings")).some(
    (bot) => verified.includes(bot.principalId),
  )
    ? STANDARD_MONTHLY_TRIAL.syntheticAiPrincipal
    : null;
}

export type StandardMonthlySyntheticProducer = {
  principalId: ChatPrincipalId;
  aliases: ChatPrincipalId[];
  sourceCommit: string;
  sourceDigest: string;
};

/** This private tuple is captured from the server's validated viewer, never reply provenance. */
export async function standardMonthlySyntheticProducer(
  room: string,
  aliases: readonly ChatPrincipalId[],
  context: Parameters<typeof standardMonthlySyntheticPrincipal>[2],
): Promise<StandardMonthlySyntheticProducer | null> {
  if (!(await standardMonthlySyntheticPrincipal(room, aliases, context)))
    return null;
  const source = standardMonthlyTrialSourceSeal(context.env);
  return {
    principalId: context.principalId!,
    aliases: servicePrincipals(context.principalId, aliases),
    sourceCommit: source.sourceCommit,
    sourceDigest: source.sourceDigest,
  };
}

export function checkedStandardMonthlySyntheticProducer(
  value: unknown,
): StandardMonthlySyntheticProducer | null {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      "aliases,principalId,sourceCommit,sourceDigest"
  )
    throw new HttpError(503, "Workspace plan could not be verified.");
  const row = value as StandardMonthlySyntheticProducer;
  if (
    normalizeChatPrincipal(row.principalId) !== row.principalId ||
    !/^[0-9a-f]{40}$/.test(row.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(row.sourceDigest) ||
    !servicePrincipals(row.principalId, row.aliases).includes(
      STANDARD_MONTHLY_TRIAL.syntheticAiPrincipal,
    )
  )
    throw new HttpError(503, "Workspace plan could not be verified.");
  return row;
}

/** Only this fixed unfunded ledger may qualify without ordinary customer money proof. */
export async function standardMonthlySyntheticLedgerOn(
  storage: Reader,
  env: TrialEnv,
  now: number,
  producer: StandardMonthlySyntheticProducer,
  period: StandardPlanPeriod,
  totalChargedCents: number,
  totalPaidCents: number,
  nextChargeCents: number,
): Promise<boolean> {
  if (
    !standardMonthlyTrialSourceAdmitted(
      env,
      STANDARD_MONTHLY_TRIAL.workspace,
      now,
    )
  )
    return false;
  const source = standardMonthlyTrialSourceSeal(env);
  if (
    producer.sourceCommit !== source.sourceCommit ||
    producer.sourceDigest !== source.sourceDigest ||
    env.PRODUCT_USAGE_AI_RESOLUTION_ENABLED !== "true" ||
    period.source !== "founder-approved" ||
    period.referenceSha256 !== STANDARD_MONTHLY_TRIAL.referenceSha256 ||
    period.operator !== STANDARD_MONTHLY_TRIAL.operator ||
    period.approvedBy !== STANDARD_MONTHLY_TRIAL.founder ||
    period.reason !== STANDARD_MONTHLY_TRIAL.reason ||
    period.startsAt < Date.parse(STANDARD_MONTHLY_TRIAL.startsAt) ||
    period.workspaceMonthlyCents !==
      PRODUCT_STANDARD_QUALIFICATION_PRICES.workspaceMonthlyUsdCents ||
    period.includedAiResolutions !==
      PRODUCT_STANDARD_QUALIFICATION_PRICES.includedAiResolutionsPerMonth ||
    period.additionalAiResolutionCents !==
      PRODUCT_STANDARD_QUALIFICATION_PRICES.additionalAiResolutionUsdCents ||
    totalPaidCents !== 0 ||
    period.paidCents !== 0 ||
    totalChargedCents + nextChargeCents > 1_000
  )
    return false;
  const settings = await storage.get<{
    roles: {
      id: string;
      enabled?: boolean;
      moderationPermissions?: string[];
    }[];
  }>("chat-settings");
  const roleIds = await currentStaffRoleIds(
    storage,
    producer.aliases,
    env,
    now,
  );
  const canAnswer =
    settings?.roles.some(
      (role) =>
        roleIds.includes(role.id) &&
        role.enabled !== false &&
        aiRole(role) &&
        role.moderationPermissions?.includes("handleConversations"),
    ) ?? false;
  return (
    (await standardMonthlySyntheticPrincipal(
      `room:${STANDARD_MONTHLY_TRIAL.workspace}`,
      producer.aliases,
      {
        env,
        storage,
        principalId: producer.principalId,
        permissions: canAnswer ? ["handleConversations"] : [],
        isBot: true,
        now,
      },
    )) !== null
  );
}
