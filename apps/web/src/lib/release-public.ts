import { immutableRelease } from "./release-immutable";
import {
  productPaymentRecipient,
  productRail,
  productRailOf,
  readProductPaymentRecipients,
  type ProductPaymentAssetSymbol,
  type ProductPaymentNetwork,
  type ProductPaymentRecipients,
} from "@templ/chat/product-payment";
import { APP_ENVIRONMENT, SITE } from "./site-environment";

/** The release manifest as the browser may see it. Private fields (grants,
 * operator coverage, approvals, hosted trial paths, policy vars) are left
 * out, so client code that reads one fails to type-check. */
type Manifest = typeof import("../../../../v4-release.json");
type PrivateField =
  | "productGrants"
  | "revokedProductGrants"
  | "operatorCoverage"
  | "approvers"
  | "approvals"
  | "legalApproval"
  | "moneyTrialApproval"
  | "stagingBasis"
  | "hostedTrials"
  | "policyVars"
  | "operatorBlockers"
  | "hostingAuthorized"
  | "workspaceFlags"
  | "productDeals"
  | "revokedProductDeals";
/** A block the projection narrows is typed as it narrows it, so a field it
 * drops cannot type-check on the client and read as undefined. */
export type PublicRelease = Omit<
  Manifest,
  PrivateField | "productOffer" | "templSupport" | "supportDiagnosis"
> & {
  indexingEnabled?: boolean;
  bitcoinAccountSignInVerified?: boolean;
  productOffer: Omit<Manifest["productOffer"], "evidence">;
  templSupport: Omit<Manifest["templSupport"], "evidence">;
  /** The projection publishes only `chains`. */
  supportDiagnosis: Pick<Manifest["supportDiagnosis"], "chains">;
};

// next.config.ts and vitest.config.ts inline the projection that
// apps/web/scripts/release-public.mjs builds from the selected release manifest. Client
// bundles get that text, never the manifest file.
const projected = process.env.TEMPL_RELEASE_PUBLIC;
if (!projected)
  throw new Error(
    "This build has no public release projection (TEMPL_RELEASE_PUBLIC).",
  );
export const BUILD_RELEASE: PublicRelease = immutableRelease(
  JSON.parse(projected),
);
export { APP_ENVIRONMENT, SITE };
if (BUILD_RELEASE.environment !== APP_ENVIRONMENT)
  throw new Error("The release record does not match this build environment.");
if (
  APP_ENVIRONMENT === "production" &&
  BUILD_RELEASE.productionReleaseEnabled !== true
)
  throw new Error("Production release is disabled by the release record.");

/** Staging remains dormant. Its build projection records retained availability. */
export const STAGING = APP_ENVIRONMENT === "staging";
export function workspaceCreationEnabled(release: PublicRelease) {
  return STAGING || release.supportWorkflowVerified === true;
}

const recipientText = process.env.TEMPL_PAYMENT_RECIPIENTS;
if (!recipientText) throw new Error("This build has no payment recipients.");
export const PAYMENT_RECIPIENTS: ProductPaymentRecipients =
  readProductPaymentRecipients(JSON.parse(recipientText));
/** The reviewed receiver for one network and token. */
export function paymentRecipient(
  network: ProductPaymentNetwork,
  symbol: ProductPaymentAssetSymbol,
) {
  const id = productRailOf(network, symbol);
  return id ? productPaymentRecipient(PAYMENT_RECIPIENTS, id) : undefined;
}
/** A rail opens only when this request's release and reviewed recipients agree. */
export function railOpen(
  release: PublicRelease,
  network: ProductPaymentNetwork,
  symbol: ProductPaymentAssetSymbol,
): boolean {
  const id = productRailOf(network, symbol);
  return id !== null && productRail(release, PAYMENT_RECIPIENTS, id).open;
}
