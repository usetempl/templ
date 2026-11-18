import type { SupportContextInput } from "@templ/chat/support";
import { FAILURE_KIND_LABELS } from "./support-widget-app";

export const EXAMPLE_VAULT_HEADER =
  "Example Vault is a demo app Templ runs to show support. It holds no funds and never asks your wallet for a transaction.";
export const EXAMPLE_VAULT_NETWORKS = {
  solana: "Solana",
  evm: "EVM (Base)",
} as const;
export type ExampleNetwork = keyof typeof EXAMPLE_VAULT_NETWORKS;
/** The three failures before anything is sent, named as the widget and the
 * team's views name them. */
export const EXAMPLE_VAULT_SCENARIOS = {
  rejected: FAILURE_KIND_LABELS.rejected,
  simulation: FAILURE_KIND_LABELS.simulation,
  submission: FAILURE_KIND_LABELS.submission,
} as const;
export type ExampleScenario = keyof typeof EXAMPLE_VAULT_SCENARIOS;
const errors = {
  evm: {
    rejected: { code: "4001", message: "User rejected the request." },
    simulation: {
      code: "eth_estimateGas",
      message: "ERC4626: deposit more than max",
    },
    submission: { code: "NONCE_TOO_LOW", message: "nonce too low" },
  },
  solana: {
    rejected: {
      code: "WalletSignTransactionError",
      message: "User rejected the request.",
    },
    simulation: {
      code: "SIMULATION_FAILED",
      message: "Program log: Error: insufficient funds",
    },
    submission: { code: "BLOCKHASH_NOT_FOUND", message: "Blockhash not found" },
  },
} as const;
/** Synthetic app failures have no transaction reference and call no wallet. */
export function exampleFailure(
  network: ExampleNetwork,
  scenario: ExampleScenario,
  action: "deposit" | "withdraw",
  at = new Date().toISOString(),
): SupportContextInput {
  const error = errors[network][scenario];
  return {
    network: network === "evm" ? "eip155:8453" : "solana",
    app: {
      page: "/example/vault",
      action,
      product: { label: "Example Vault" },
      error: {
        code: error.code,
        message: `Example scenario: ${EXAMPLE_VAULT_SCENARIOS[scenario]}. ${error.message}`,
      },
      failure: { kind: scenario, at },
    },
  };
}
