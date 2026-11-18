import type { SupportContextInput } from "@templ/chat/support";

/** The retained public solana-usdc-failed sample, never a visitor transaction. */
export const PUBLIC_SOLANA_FAILURE = {
  signature:
    "mXnUwwsAjwCxED4vhbzXbgakTCbLMSL93Pt4TRBevPxUr12m42QGRtwexgDkGVCECnamg9Vd4kT5PimX9M1zser",
  failedAt: "2026-10-02T03:52:29Z",
} as const;

export const PUBLIC_SOLANA_QUESTION = "Why did this public sample fail?";

export function publicSolanaFailure(): SupportContextInput {
  return {
    network: "solana",
    transactions: [
      { network: "solana", hash: PUBLIC_SOLANA_FAILURE.signature },
    ],
    app: {
      action: "other",
      product: { label: "Public failure sample" },
      error: {
        code: "Custom:1",
        message:
          "Public sample: insufficient funds. This is not your transaction or wallet.",
      },
      failure: { kind: "broadcast", at: PUBLIC_SOLANA_FAILURE.failedAt },
    },
  };
}
