import {
  PRODUCT_LIMITS,
  PRODUCT_STANDARD_PRICES as PRICES,
} from "@templ/chat/plans";
import { formatUsdCents as dollars } from "@templ/chat/resolution-copy";
import { InstallPromptButton } from "./landing-install";
import { SITE } from "@/lib/site-environment";
import styles from "./landing-pricing.module.css";

export function LandingPricing() {
  return (
    <section
      id="pricing"
      className={styles.plans}
      aria-labelledby="pricing-title"
    >
      <div>
        <h2 id="pricing-title">One workspace. Your whole team.</h2>
        <p className={styles.price}>
          {dollars(PRICES.workspaceMonthlyUsdCents)}
          <span> / month</span>
        </p>
        <p>
          {PRICES.includedAnsweredCasesPerMonth} answered cases ·{" "}
          {dollars(PRICES.includedAiCreditUsdCents)} AI credit · No seat fees
        </p>
        <a
          href={`${SITE.docs}/pricing`}
          data-templ-conversion="pricing_rules_clicked"
        >
          Full pricing details
        </a>
      </div>
      <div id="install" className={styles.install}>
        <h3>Start inside your app.</h3>
        <p>
          Try {PRODUCT_LIMITS.freeSupportTickets} test tickets free, without
          Templ AI.
        </p>
        <InstallPromptButton className={styles.contact} />
        <a href={`${SITE.docs}/install`}>Read the install guide</a>
      </div>
    </section>
  );
}
