import { PRODUCT_STARTER_PRICES, PRODUCT_STANDARD_AI_RATES, PRODUCT_TERRA_AI_RATES } from "@templ/chat/plans";

export const LEGACY_SUPPORT_MODEL = PRODUCT_STANDARD_AI_RATES.model;
export const DEFAULT_SUPPORT_MODEL = LEGACY_SUPPORT_MODEL;
export const TERRA_SUPPORT_MODEL = PRODUCT_TERRA_AI_RATES.model;
export const CRYPTO_SUPPORT_WORKSPACE: string = "";
export const CRYPTO_SUPPORT_MODEL = "gpt-6.2-sol";
export const CRYPTO_MONTHLY_BUDGET_CENTS = 50_000;
export const CRYPTO_REPLY_LIMIT = 2400;

export type SupportModel =
  | typeof LEGACY_SUPPORT_MODEL
  | typeof TERRA_SUPPORT_MODEL
  | typeof CRYPTO_SUPPORT_MODEL;

export function prepaidRateCardLabel(cardVersion: string) {
  if (cardVersion === PRODUCT_TERRA_AI_RATES.version) return "GPT-6.1 Terra";
  if (cardVersion === PRODUCT_STANDARD_AI_RATES.version || cardVersion === PRODUCT_STARTER_PRICES.aiRateCardVersion) return "GPT-6.1 Sol";
  return "the recorded model";
}

export function prepaidSupportModel(cardVersion: string) {
  return cardVersion === PRODUCT_TERRA_AI_RATES.version ? TERRA_SUPPORT_MODEL : LEGACY_SUPPORT_MODEL;
}

export function supportModel(workspace?: string): SupportModel {
  return workspace === CRYPTO_SUPPORT_WORKSPACE
    ? CRYPTO_SUPPORT_MODEL
    : DEFAULT_SUPPORT_MODEL;
}

export function supportEffort(model: SupportModel) {
  return model === CRYPTO_SUPPORT_MODEL ? "xhigh" : model === LEGACY_SUPPORT_MODEL ? "medium" : "low";
}
