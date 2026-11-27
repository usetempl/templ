export const DEFAULT_SUPPORT_MODEL = "gpt-6.1-sol";
export const CRYPTO_SUPPORT_WORKSPACE: string = "";
export const CRYPTO_SUPPORT_MODEL = "gpt-6.2-sol";
export const CRYPTO_MONTHLY_BUDGET_CENTS = 50_000;
export const CRYPTO_REPLY_LIMIT = 2400;

export function supportModel(workspace?: string) {
  return workspace === CRYPTO_SUPPORT_WORKSPACE
    ? CRYPTO_SUPPORT_MODEL
    : DEFAULT_SUPPORT_MODEL;
}
