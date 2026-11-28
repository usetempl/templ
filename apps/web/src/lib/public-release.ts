import {
  PRODUCT_OFFER_VERSION,
  PRODUCT_STANDARD_PRICES,
  PRODUCT_RESOLUTION_RULES,
  PRODUCT_LIMITS,
} from "@templ/chat/plans";
import type { ReleaseFlags } from "@templ/chat/availability";
import { liveFeatureLimits } from "@templ/chat/feature-limits";
import { getChatChain } from "@templ/chat/chains";
import {
  PRODUCT_CHECKOUT_OPTIONS,
  getProductPaymentAsset,
  type ProductPaymentAssetSymbol,
  type ProductPaymentNetwork,
} from "@templ/chat/product-payment";
import { ACCOUNT_METHOD_LIMITS } from "@templ/chat/wallets";
import { capabilities } from "./current-capabilities";
import { agentApiStatus } from "./agent-api";
import { PRIORITY_RELEASE_SCOPE } from "./priority-scope";
import {
  PAYMENT_RECIPIENTS,
  BUILD_RELEASE,
  type PublicRelease,
  workspaceCreationEnabled,
  railOpen,
} from "./config";
import { SITE } from "./site-environment";
import {
  supportCapabilities,
  WIDGET_WALLET_SUPPORT,
} from "./support-availability";
import { templSupportWorkspace } from "./templ-support";
import {
  SUPPORT_WIDGET_LATEST,
  SUPPORT_WIDGET_SUPPORT_DAYS,
  supportedWidgetVersions,
} from "./support-widget-release";

/** Public checkout for one asset on one network: its rail is open. */
function productCheckoutOn(
  release: PublicRelease,
  chainId: ProductPaymentNetwork,
  symbol: ProductPaymentAssetSymbol,
) {
  return railOpen(release, chainId, symbol);
}

/** Public support availability. Internal storage and contract fields are not
 * offered through this projection. Runtime account capabilities remain
 * authoritative for the sign-in choices on a particular host. */
export function publicReleaseStatus(RELEASE: PublicRelease = BUILD_RELEASE) {
  const paymentNetworks = PRODUCT_CHECKOUT_OPTIONS.map(
    ({ network, symbol }) => ({
      id: network,
      name: network === "solana" ? "Solana" : getChatChain(network).name,
      assets: [
        {
          symbol,
          configured: Boolean(getProductPaymentAsset(network, symbol)),
          payable: productCheckoutOn(RELEASE, network, symbol),
        },
      ],
    }),
  );
  const templWorkspace = templSupportWorkspace(
    RELEASE,
    SITE.origin,
    SITE.origin,
  );
  return {
    environment: RELEASE.environment,
    productionReleaseEnabled: RELEASE.productionReleaseEnabled,
    blockers: RELEASE.blockers,
    workspace: {
      creationEnabled: workspaceCreationEnabled(RELEASE),
      creationVerified: RELEASE.supportWorkflowVerified === true,
    },
    safetyServiceVerified: RELEASE.safetyServiceVerified === true,
    /** Talk to Templ opens its own widget or shows a retry action. */
    contact: {
      mode: templWorkspace
        ? ("templ-widget" as const)
        : ("widget-unavailable" as const),
    },
    support: {
      conversationsVerified: RELEASE.conversationsVerified === true,
      workflowVerified: RELEASE.supportWorkflowVerified === true,
      widgetVerified: RELEASE.supportWidgetVerified === true,
      connectVerified: RELEASE.supportConnectVerified === true,
      templWorkspace,
      widgetPath: "/support-widget.js",
      /** Immutable builds. Snippets load `latest.path`; a replaced build
       * keeps working until its `supportedUntil` date. */
      widget: {
        latest: {
          path: SUPPORT_WIDGET_LATEST.path,
          sha256: SUPPORT_WIDGET_LATEST.sha256,
          sha384: SUPPORT_WIDGET_LATEST.sha384,
          bytes: SUPPORT_WIDGET_LATEST.bytes,
          gzipBytes: SUPPORT_WIDGET_LATEST.gzipBytes,
          /** Files it loads on first use, as immutable as itself. */
          chunks: SUPPORT_WIDGET_LATEST.chunks,
        },
        supported: supportedWidgetVersions().map((version) => ({
          path: version.path,
          sha256: version.sha256,
          /** Base64 SHA-384 for a script tag's integrity attribute. */
          sha384: version.sha384,
          supportedUntil: version.supportedUntil,
        })),
        supportDays: SUPPORT_WIDGET_SUPPORT_DAYS,
      },
      walletSupport: WIDGET_WALLET_SUPPORT,
      notificationsVerified:
        supportCapabilities(RELEASE).SUPPORT_NOTIFICATIONS_VERIFIED,
      storageVerified: RELEASE.mediaStorageVerified === true,
      priorities: {
        verified: RELEASE.priorityFeedVerified === true,
        scope:
          RELEASE.priorityFeedVerified === true ? PRIORITY_RELEASE_SCOPE : null,
      },
    },
    productOffer: {
      version: PRODUCT_OFFER_VERSION,
      standardPricing: {
        ...PRODUCT_STANDARD_PRICES,
        signedAgreementRequired: true,
        availabilityPath: "/availability",
      },
      softwareUsage: {
        templAiIncludesFeatures: true,
        templAiRequiresUserConfirmation: true,
        confirmationWindowHours: PRODUCT_RESOLUTION_RULES.memberFinalHours,
        signedAgreementRequired: true,
        featureBillingVerified: RELEASE.productManualBillingVerified === true,
        templAiResolutionBillingVerified:
          RELEASE.productManualBillingVerified === true &&
          RELEASE.productUsageAiResolutionVerified === true,
      },
      services: {
        managedAgentSetup: "included-standard-features-custom-work-agreed",
        managedAgentMaintenance:
          "included-standard-features-custom-work-agreed",
        humanSupport: "separate-agreed-scope-and-staffed-hours",
      },
      /** Support limits, plus a feature's limits once its flag is true. */
      limits: {
        ...PRODUCT_LIMITS,
        ...liveFeatureLimits(RELEASE as unknown as Record<string, unknown>),
      },
      automaticRenewal: false,
      checkoutVerified: paymentNetworks.some((network) =>
        network.assets.some((asset) => asset.payable),
      ),
      cardBillingVerified: RELEASE.cardBillingVerified === true,
      paymentNetworks,
    },
    capabilities: capabilities(
      RELEASE as unknown as ReleaseFlags,
      PAYMENT_RECIPIENTS,
    ),
    // Sign-in follows the adopted production flag.
    accounts: {
      wallet: true,
      bitcoinSignIn: RELEASE.bitcoinAccountSignInVerified === true,
      signIn:
        RELEASE.emailSignInVerified === true
          ? "Wallet or email"
          : "Wallet",
      methods: ACCOUNT_METHOD_LIMITS,
      methodsPath: "/settings/account",
      capabilitiesRoute: "/auth/capabilities",
    },
    agents: {
      path: "/agents",
      guide: "/agents.md",
      setup: `${SITE.docs}/developers/support-agent`,
      sdkVerified: RELEASE.agentSdkVerified === true,
      // Agent API version, features and the Python client's hash.
      ...agentApiStatus(RELEASE, SITE.docs),
    },
    assets: {
      agentClientSha256: buildHash(process.env.TEMPL_AGENT_CLIENT_SHA256),
      agentClientSourceSha256: buildHash(
        process.env.TEMPL_AGENT_CLIENT_SOURCE_SHA256,
      ),
    },
  };
}
/** Only a full lowercase SHA-256 is published; anything else reads as unknown. */
function buildHash(value: string | undefined) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}
