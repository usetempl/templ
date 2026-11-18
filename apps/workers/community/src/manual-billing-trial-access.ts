import { normalizeChatPrincipal } from "@templ/chat/principal";
import { isTrialOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import {
  manualBillingTrialScope,
  type WorkspaceFlagEnv,
} from "./workspace-flags";
import { HttpError } from "./common";
import type { NativeRoomRecord } from "./native-rooms";
import type { ProductOrderForm } from "./product-order-forms";

/** The signed disposable agreement grants no general operator or payment authority. */
export const APPROVED_MANUAL_USAGE_TRIAL = Object.freeze({
  workspace: "01a11943-d5e7-7e12-90d3-f2a20fbb4a31",
  manager: "0xd895410f44dd2ae6da0aa4b85619670454f2da02",
  operator: "0x5498b97be0786c1de0166fd554fb55a091603e36",
  founder: "0x5b87102358a61bc9a6d32b20b121bbfd2a535c8d",
  documentSha256:
    "60b9a9e2c5dd328c84c992259d93a3745cd2286a1b15e767030b0289543392eb",
  approvalSha256:
    "26c1266d337113c61d3ccc0e1a3304f4d775413bdce529d6ba3ef86bc7dc3fa1",
  authorizedAt: "2026-10-08T02:28:26.693Z",
  until: "2026-10-10T00:00:00.000Z",
  forgivenessSha256:
    "b28a49941682a39bd06a539c1a29cee9fc81d1d006ecc8c1b37630e993b37d94",
  usage: Object.freeze({
    version: "2026-10-06",
    walletVerificationUsdCents: 5,
    transactionCheckUsdCents: 10,
    aiDraftUsdCents: 10,
    templAiResolutionUsdCents: 100,
    debtLimitCents: 100,
    templAiPrincipal: "0x143b4101f506419982a83f2e9fe1f9553dd04c17",
  }),
});
/** Dated founder approval authorizes only this synthetic AI fee agreement. */
export const APPROVED_USAGE_AI_TRIAL = Object.freeze({
  workspace: "01a11eb2-7a82-7b83-bf1d-ab36814f9932",
  manager: "0xd26a957243a5ce9961f89dc1e2926f6e2623a769",
  operator: "0x5498b97be0786c1de0166fd554fb55a091603e36",
  founder: "0x5b87102358a61bc9a6d32b20b121bbfd2a535c8d",
  documentSha256:
    "f096cd105b64a3f9f73a3eda45d51846e975908fa2db1a7064e551a3e8aafb94",
  authorizationSha256:
    "fd0c47f3ad704b73e5eae84194dd8844b28314d33ecfdd656fa472c3a80480df",
  scopeSha256:
    "102ccd07b0091d83757be3677c2f32b37c84ffb7bb7c10d8b76320afdf096ebd",
  approvalSha256:
    "f491533e34e013ef303c259afdf5c3f25700fdec55632a1fb690508ff36686ec",
  authorizedAt: "2026-10-09T03:36:45.452Z",
  until: "2026-10-12T00:00:00.000Z",
  forgivenessSha256:
    "28a420b7774999c6fd54ea8875e719e37ec1f87de566549958599686de860194",
  forgivenessReason: "Synthetic AI resolution verification",
  usage: Object.freeze({
    version: "2026-10-06",
    walletVerificationUsdCents: 5,
    transactionCheckUsdCents: 10,
    aiDraftUsdCents: 10,
    templAiResolutionUsdCents: 100,
    debtLimitCents: 1000,
    templAiPrincipal: "0x2903395b8b4574f1835318e6a40d8e245c93184f",
    templAiResolutionEnabled: true,
  }),
});
const approvedUsageTrial = (workspace: unknown) =>
  [APPROVED_MANUAL_USAGE_TRIAL, APPROVED_USAGE_AI_TRIAL].find(
    (trial) => trial.workspace === workspace,
  );
type TrialEnv = WorkspaceFlagEnv & OperatorAdminEnv;
type Reader = { get<T = unknown>(key: string): Promise<T | undefined> };
const refuse = (): never => {
  throw new HttpError(404, "Not found.");
};
export function approvedManualBillingTrial(
  env: TrialEnv,
  actor: unknown,
  workspace: unknown,
  now = Date.now(),
): boolean {
  const approved = approvedUsageTrial(workspace);
  if (!approved) return false;
  const principal = normalizeChatPrincipal(actor);
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    env.PRODUCT_MANUAL_BILLING_ENABLED !== "true" ||
    principal !== approved.operator ||
    workspace !== approved.workspace ||
    !isTrialOperatorAdmin(env, principal, [principal])
  )
    return false;
  const scope = manualBillingTrialScope(env, workspace, principal, now);
  return Boolean(
    scope &&
    scope.until === approved.until &&
    scope.approvalSha256 === approved.approvalSha256 &&
    now >= Date.parse(approved.authorizedAt),
  );
}
export async function assertManualBillingTrialWorkspace(
  storage: Reader,
  env: TrialEnv,
  actor: unknown,
  now = Date.now(),
) {
  const native = await storage.get<NativeRoomRecord>("native-room");
  const approved = approvedUsageTrial(native?.room.id);
  if (!approved) return refuse();
  const created = Date.parse(native?.room.createdAt ?? "");
  const product = await storage.get<{ creator?: unknown }>(
    "product-entitlements-v1",
  );
  if (
    !native ||
    !approvedManualBillingTrial(env, actor, native.room.id, now) ||
    native.room.creator !== approved.manager ||
    native.room.manager !== approved.manager ||
    native.trialOperator !== approved.operator ||
    !Number.isFinite(created) ||
    created < Date.parse(approved.authorizedAt) ||
    created > now ||
    (product && product.creator !== approved.manager) ||
    (await storage.get("workspace-deletion-v1")) !== undefined
  )
    refuse();
}
export function assertManualBillingTrialForm(form: Partial<ProductOrderForm>) {
  const approved = approvedUsageTrial(form.workspace?.replace(/^room:/, ""));
  if (!approved) return refuse();
  if (
    form.workspace !== `room:${approved.workspace}` ||
    form.service !== "software" ||
    form.pilot !== undefined ||
    form.documentSha256 !== approved.documentSha256 ||
    form.approvedBy !== approved.founder ||
    form.revision !== 1 ||
    !Number.isSafeInteger(form.startsAt) ||
    form.startsAt! < Date.parse(approved.authorizedAt) ||
    form.endsAt !== Date.parse(approved.until) ||
    !form.usage ||
    Object.keys(form.usage).length !== Object.keys(approved.usage).length ||
    Object.entries(approved.usage).some(
      ([key, value]) =>
        form.usage![key as keyof typeof approved.usage] !== value,
    )
  )
    refuse();
}
export function approvedUsageAiResolutionTrial(
  env: TrialEnv,
  actor: unknown,
  workspace: unknown,
  now = Date.now(),
): boolean {
  return (
    workspace === APPROVED_USAGE_AI_TRIAL.workspace &&
    env.PRODUCT_USAGE_AI_RESOLUTION_ENABLED === "true" &&
    approvedManualBillingTrial(env, actor, workspace, now)
  );
}
export function assertManualBillingTrialAction(
  body: Record<string, unknown>,
  workspace: string,
) {
  const approved = approvedUsageTrial(workspace);
  if (!approved) return refuse();
  if (body.action === "usage-approve") {
    if (
      body.approvedBy !== approved.founder ||
      body.revision !== 1 ||
      typeof body.formId !== "string" ||
      !/^OF-\d{4}-\d{3}$/.test(body.formId) ||
      typeof body.enabled !== "boolean"
    )
      refuse();
  } else if (body.action === "usage-forgive") {
    if (
      body.referenceSha256 !== approved.forgivenessSha256 ||
      (approved === APPROVED_USAGE_AI_TRIAL
        ? !Number.isSafeInteger(body.cents) ||
          Number(body.cents) < 1 ||
          Number(body.cents) > approved.usage.debtLimitCents ||
          body.reason !== approved.forgivenessReason
        : body.cents !== 25)
    )
      refuse();
  } else refuse();
}
