/** Capability facts derive from the current request's release flags.
 * Their mapping grants no access and activates no feature. */
import CAPABILITY_FLAGS from "./capability-flags.json";
import { BUILD_RELEASE } from "./release-public";

export type CapabilityName = keyof typeof CAPABILITY_FLAGS;
/** A dotted path into the release record: `supportAlerts.slack`. */
function flagOn(release: object, path: string): boolean {
  let value: unknown = release;
  for (const key of path.split("."))
    value =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return value === true;
}
/** True when every flag of one of the capability's clauses is true. */
export function capabilityVerified(
  name: CapabilityName,
  release: object = BUILD_RELEASE,
): boolean {
  return CAPABILITY_FLAGS[name].some((clause) =>
    clause.every((path) => flagOn(release, path)),
  );
}

/** EVM widget sign-in remains limited to externally owned wallets. */
export const WIDGET_WALLET_SUPPORT = "eoa-only" as const;
const evmSignIn = Object.freeze(["evm"] as const);
const evmAndSolanaSignIn = Object.freeze(["evm", "solana"] as const);
export function widgetSignInNetworks(
  release: object,
): readonly ("evm" | "solana")[] {
  return flagOn(release, "supportWidgetSolanaVerified")
    ? evmAndSolanaSignIn
    : evmSignIn;
}

/** Each named capability reads its own flags from this request. */
export function supportCapabilities(release: object) {
  return {
    CARD_BILLING_VERIFIED: capabilityVerified("CARD_BILLING_VERIFIED", release),
    EMAIL_SIGN_IN_VERIFIED: capabilityVerified("EMAIL_SIGN_IN_VERIFIED", release),
    SUPPORT_NOTIFICATIONS_VERIFIED: capabilityVerified(
      "SUPPORT_NOTIFICATIONS_VERIFIED",
      release,
    ),
    TRANSACTION_CHECKS_VERIFIED: capabilityVerified(
      "TRANSACTION_CHECKS_VERIFIED",
      release,
    ),
    TEAM_CHANNEL_ALERTS_VERIFIED: capabilityVerified(
      "TEAM_CHANNEL_ALERTS_VERIFIED",
      release,
    ),
    TELEGRAM_ALERTS_VERIFIED: capabilityVerified(
      "TELEGRAM_ALERTS_VERIFIED",
      release,
    ),
    TYPED_CONTEXT_VERIFIED: capabilityVerified(
      "TYPED_CONTEXT_VERIFIED",
      release,
    ),
    SECRET_GUARD_VERIFIED: capabilityVerified("SECRET_GUARD_VERIFIED", release),
    AI_MODE_VERIFIED: capabilityVerified("AI_MODE_VERIFIED", release),
    ASK_AI_VERIFIED: capabilityVerified("ASK_AI_VERIFIED", release),
    FOLLOW_UPS_VERIFIED: capabilityVerified("FOLLOW_UPS_VERIFIED", release),
    EVIDENCE_CHECK_VERIFIED: capabilityVerified(
      "EVIDENCE_CHECK_VERIFIED",
      release,
    ),
  };
}
