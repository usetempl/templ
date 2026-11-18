/** The wallet families the install prompt names, as the card's chips. EVM
 * always; Solana after its hosted record or for a workspace with sign-in on. */
export function installFamilies(
  release: { supportWidgetSolanaVerified?: boolean },
  workspaceFeatures: { solanaSignIn?: boolean } = {},
): readonly string[] {
  return release.supportWidgetSolanaVerified === true ||
    workspaceFeatures.solanaSignIn === true
    ? ["EVM", "Solana"]
    : ["EVM"];
}
