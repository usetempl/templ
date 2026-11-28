/** One capability model for what Templ presents as available. The worker's
 * enforcement, the web app's rendering, `/api/status` and the public
 * `/availability` page all read this projection, so no surface decides
 * availability from a configured recipient, a runtime flag or a stale boolean on
 * its own. Pure and browser-safe: it reads release flags and recipient config only.
 *
 * States, from least to most proven:
 * - implemented: the code path exists behind a false flag.
 * - pinned: a recipient and allowlisted token are configured.
 * - hosted-verified: the hosted trial for this exact release passed.
 * - economically-verified: the invoice-backed cost record for this offer exists.
 * - available: everything the feature needs is recorded; it is offered today.
 * A balance top-up needs "available"; a configured recipient alone never opens it. */
import { CHAT_CHAINS, CHAT_CHAIN_IDS, type ChatChainId } from "./chains";
import {
  productRails,
  type ProductPaymentRecipients,
  type ProductRailRelease,
} from "./product-payment";

export type CapabilityState =
  | "implemented"
  | "pinned"
  | "hosted-verified"
  | "economically-verified"
  | "available";
/** The plain public wording for a capability. */
export type PublicAvailability = "available" | "being-verified" | "not-offered";
export type CapabilityId =
  | "accounts.wallet"
  | "accounts.solana"
  | "accounts.bitcoin"
  | "plans.purchase"
  | "conversations.team"
  | "conversations.claims"
  | "agents.sdk";
export type ChainCapability = {
  chainId: ChatChainId;
  name: string;
  state: CapabilityState;
  public: PublicAvailability;
};
export type Capability = {
  id: CapabilityId;
  label: string;
  state: CapabilityState;
  public: PublicAvailability;
  /** Per network when the capability binds a chain; absent otherwise. */
  chains?: ChainCapability[];
  /** The flag or record that would move it forward; a name, never a secret. */
  evidence: string;
};
/** The subset of v4-release.json the model and its readers use. Unknown
 * fields are ignored; a missing flag reads as false. */
export type ReleaseFlags = ProductRailRelease & {
  environment?: string;
  bitcoinAccountSignInVerified?: boolean;
  realtimeVerified?: boolean;
  mediaStorageVerified?: boolean;
  /** Solana: sign-in needs no provider. */
  solana?: {
    signIn?: boolean;
    planBilling?: string;
  };
  conversationsVerified?: boolean;
  supportWorkflowVerified?: boolean;
  agentSdkVerified?: boolean;
};
const flag = (value: unknown) => value === true;
const chainName = (chainId: ChatChainId) =>
  CHAT_CHAINS.find((chain) => chain.id === chainId)?.name ?? String(chainId);
const publicOf = (state: CapabilityState): PublicAvailability =>
  state === "available" ? "available" : "being-verified";

function chainStates(
  resolve: (chainId: ChatChainId) => CapabilityState,
): ChainCapability[] {
  return CHAT_CHAIN_IDS.map((chainId) => {
    const state = resolve(chainId);
    return {
      chainId,
      name: chainName(chainId),
      state,
      public: publicOf(state),
    };
  });
}
const best = (chains: ChainCapability[]): CapabilityState =>
  chains.some((chain) => chain.state === "available")
    ? "available"
    : chains.some((chain) => chain.state === "hosted-verified")
      ? "hosted-verified"
      : chains.some((chain) => chain.state === "pinned")
        ? "pinned"
        : "implemented";

/** The full projection. Every row follows its own evidence; checkout reads
 * the configured payment recipients, which the caller passes (none by default). */
export function capabilities(
  release: ReleaseFlags,
  recipients: ProductPaymentRecipients = {},
): Capability[] {
  const verified = (value: unknown): CapabilityState =>
    flag(value) ? "available" : "implemented";
  const supportClaims = verified(
    flag(release.conversationsVerified) &&
      flag(release.supportWorkflowVerified),
  );
  const rails = productRails(release, recipients);
  const purchase = chainStates((chainId) => {
    const networkRails = rails.filter((entry) => entry.network === chainId);
    if (networkRails.some((rail) => rail.open)) return "available";
    return networkRails.some((rail) => rail.recipient)
      ? "pinned"
      : "implemented";
  });
  const solana = rails.filter((rail) => rail.network === "solana");
  const purchaseState: CapabilityState = solana.some((rail) => rail.open)
    ? "available"
    : best(purchase) === "implemented" && solana.some((rail) => rail.recipient)
      ? "pinned"
      : best(purchase);
  return [
    {
      // Sign In With Ethereum needs no provider or release flag.
      id: "accounts.wallet",
      label: "EVM wallet sign-in",
      state: "available",
      public: "available",
      evidence: "Sign In With Ethereum",
    },
    {
      id: "accounts.solana",
      label: "Solana wallet sign-in",
      state: flag(release.solana?.signIn) ? "available" : "implemented",
      public: publicOf(
        flag(release.solana?.signIn) ? "available" : "implemented",
      ),
      evidence: "solana.signIn",
    },
    {
      id: "accounts.bitcoin",
      label: "Bitcoin wallet sign-in",
      state: verified(release.bitcoinAccountSignInVerified),
      public: publicOf(verified(release.bitcoinAccountSignInVerified)),
      evidence: "bitcoinAccountSignInVerified",
    },
    {
      id: "plans.purchase",
      label: "Balance top-ups",
      state: purchaseState,
      public: publicOf(purchaseState),
      chains: purchase,
      evidence: "productOffer.checkoutVerified + productOffer.rails",
    },
    {
      id: "conversations.team",
      label: "User cases",
      state: verified(release.conversationsVerified),
      public: publicOf(verified(release.conversationsVerified)),
      evidence: "conversationsVerified",
    },
    {
      id: "conversations.claims",
      label: "Support staff workflow",
      state: supportClaims,
      public: publicOf(supportClaims),
      evidence: "conversationsVerified + supportWorkflowVerified",
    },
    {
      id: "agents.sdk",
      label: "AI agents through the published client",
      state: verified(release.agentSdkVerified),
      public: publicOf(verified(release.agentSdkVerified)),
      evidence: "agentSdkVerified",
    },
  ];
}
export function capability(
  release: ReleaseFlags,
  id: CapabilityId,
  recipients: ProductPaymentRecipients = {},
): Capability {
  return capabilities(release, recipients).find((row) => row.id === id)!;
}
export function isAvailable(
  release: ReleaseFlags,
  id: CapabilityId,
  recipients: ProductPaymentRecipients = {},
): boolean {
  return capability(release, id, recipients).public === "available";
}
