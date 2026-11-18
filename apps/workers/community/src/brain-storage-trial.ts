import approved from "./brain-storage-trial-scopes.json" with { type: "json" };
import { BRAIN_STORAGE_PRICE } from "@templ/chat/brain-storage";
export type StorageTrialScope = {
  workspace: string;
  manager: string;
  operator: string;
  agreementId: string;
  revision: number;
  documentSha256: string;
  termsSha256: string;
  debtLimitCents: number;
  priceVersion: string;
  startsAt: number;
  endsAt: number;
  syntheticReceiptsOnly: true;
  allowedActions: string[];
  founderWalletUsed: false;
  financialTransactionsAllowed: false;
  customerChargesAllowed: false;
  newRecurringPurchaseAllowed: false;
  founderApprovalPath: string;
  founderApprovalSha256: string;
};
const KEYS =
  "agreementId,allowedActions,customerChargesAllowed,debtLimitCents,documentSha256,endsAt,financialTransactionsAllowed,founderApprovalPath,founderApprovalSha256,founderWalletUsed,manager,newRecurringPurchaseAllowed,operator,priceVersion,revision,startsAt,syntheticReceiptsOnly,termsSha256,workspace";
export function approvedStorageTrialScope(
  env: { BRAIN_STORAGE_COLLECTION_TRIAL_SCOPE?: string },
  workspace?: string,
  documentSha256?: string,
  manager?: string,
  now = Date.now(),
): StorageTrialScope | undefined {
  try {
    const scopes: unknown = JSON.parse(
      env.BRAIN_STORAGE_COLLECTION_TRIAL_SCOPE ?? "[]",
    );
    if (
      JSON.stringify(scopes) !== JSON.stringify(approved) ||
      !Array.isArray(scopes)
    )
      return;
    return scopes.find(
      (s) =>
        s &&
        Object.keys(s).sort().join() === KEYS &&
        s.workspace === workspace &&
        (documentSha256 === undefined || s.documentSha256 === documentSha256) &&
        (manager === undefined || s.manager === manager) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          s.workspace,
        ) &&
        /^0x[a-f0-9]{40}$/.test(s.manager) &&
        s.operator === "0x5498b97be0786c1de0166fd554fb55a091603e36" &&
        /^BS-\d{4}-\d{3}$/.test(s.agreementId) &&
        s.revision === 1 &&
        s.debtLimitCents === 100 &&
        s.priceVersion === BRAIN_STORAGE_PRICE.version &&
        s.syntheticReceiptsOnly === true &&
        s.founderWalletUsed === false &&
        s.financialTransactionsAllowed === false &&
        s.customerChargesAllowed === false &&
        s.newRecurringPurchaseAllowed === false &&
        JSON.stringify(s.allowedActions) ===
          JSON.stringify(["record", "end", "payment", "credit", "forgive"]) &&
        /^packages\/evm\/contracts-v4\/deployments\/production\/brain-storage-trial-\d{8}\/founder-approval\.json$/.test(
          s.founderApprovalPath,
        ) &&
        [s.documentSha256, s.termsSha256, s.founderApprovalSha256].every(
          (value) => /^[a-f0-9]{64}$/.test(value),
        ) &&
        Number.isSafeInteger(s.startsAt) &&
        Number.isSafeInteger(s.endsAt) &&
        s.endsAt > s.startsAt &&
        s.endsAt - s.startsAt <= 7 * 86_400_000 &&
        s.startsAt <= now &&
        now < s.endsAt,
    );
  } catch {
    return;
  }
}
export function approvedStorageTrial(
  env: { BRAIN_STORAGE_COLLECTION_TRIAL_SCOPE?: string },
  workspace?: string,
  documentSha256?: string,
  manager?: string,
  now = Date.now(),
): boolean {
  return Boolean(
    documentSha256 &&
    manager &&
    approvedStorageTrialScope(env, workspace, documentSha256, manager, now),
  );
}
