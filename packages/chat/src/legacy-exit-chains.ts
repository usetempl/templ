import type { SupportWalletChain } from "./chains";
import { SUPPORT_WALLET_CHAINS } from "./chains";

/** Networks members mostly leave: Templ names them for a shared transaction
 * or a wallet a member reports, and nothing more. Widget sign-in stays off
 * (`siwe: false`) until a release moves a row into SUPPORT_WALLET_CHAINS
 * with its own widget stage, and no keyed provider pair exists for them.
 * Kept in this module, apart from chains.ts, so the widget chunks
 * don't carry them. */
export const LEGACY_EXIT_CHAINS = [
  {
    id: 100,
    name: "Gnosis",
    tx: "https://gnosisscan.io/tx/{hash}",
    address: "https://gnosisscan.io/address/{address}",
    siwe: false,
    diagnosisReady: false,
  },
  {
    id: 250,
    name: "Fantom",
    tx: "https://ftmscan.com/tx/{hash}",
    address: "https://ftmscan.com/address/{address}",
    siwe: false,
    diagnosisReady: false,
  },
] as const satisfies readonly SupportWalletChain[];
/** Every EVM network Templ names: the wallet chains, then the legacy exits.
 * A function, not a constant, so bundles that never call it drop both rows. */
export function namedEvmChains(): readonly SupportWalletChain[] {
  return [...SUPPORT_WALLET_CHAINS, ...LEGACY_EXIT_CHAINS];
}
/** A named network, legacy exits included; null for any other id. */
export function namedEvmChain(id: number): SupportWalletChain | null {
  return namedEvmChains().find((chain) => chain.id === id) ?? null;
}
