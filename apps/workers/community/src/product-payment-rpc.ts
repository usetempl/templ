/** Payment authority uses explicit provider pairs without enabling those providers for diagnosis or sign-in. */
export type ProductPaymentRpcSecrets = {
  PRODUCT_PAYMENT_ETHEREUM_CONFIRMATION_RPC_URL?: string;
  PRODUCT_PAYMENT_BASE_CONFIRMATION_RPC_URL?: string;
  PRODUCT_PAYMENT_SOLANA_AUTH_RPC_URL?: string;
  PRODUCT_PAYMENT_SOLANA_CONFIRMATION_RPC_URL?: string;
};
export function productPaymentRpcEnv<T extends object>(env: T): T {
  const source = env as T & ProductPaymentRpcSecrets;
  const mapped = { ...env } as unknown as Record<string, unknown>;
  for (const prefix of ["ETHEREUM", "BASE"] as const) {
    const value = source[`PRODUCT_PAYMENT_${prefix}_CONFIRMATION_RPC_URL`];
    if (value !== undefined) mapped[`${prefix}_CONFIRMATION_RPC_URL`] = value;
  }
  if (
    source.PRODUCT_PAYMENT_SOLANA_AUTH_RPC_URL !== undefined ||
    source.PRODUCT_PAYMENT_SOLANA_CONFIRMATION_RPC_URL !== undefined
  ) {
    mapped.SOLANA_AUTH_RPC_URL = source.PRODUCT_PAYMENT_SOLANA_AUTH_RPC_URL;
    mapped.SOLANA_CONFIRMATION_RPC_URL =
      source.PRODUCT_PAYMENT_SOLANA_CONFIRMATION_RPC_URL;
  }
  return mapped as T;
}
