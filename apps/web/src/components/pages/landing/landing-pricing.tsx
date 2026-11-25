import { PRODUCT_ANNUAL_PRICES as ANNUAL, PRODUCT_LIMITS, PRODUCT_STARTER_PRICES as STARTER, PRODUCT_STANDARD_PRICES as PLUS } from "@templ/chat/plans";
import { formatUsdCents as dollars } from "@templ/chat/resolution-copy";
import { SITE } from "@/lib/site-environment";
import { LandingActions } from "./landing-install";
import styles from "./landing-pricing.module.css";

export function LandingPricing() {
  return (
    <section id="pricing" className={styles.plans} aria-labelledby="pricing-title">
      <h2 id="pricing-title">Claim your <span>/brand</span> support line.</h2>
      <div className={styles.choices}>
        <section id="install" className={styles.trial} aria-labelledby="trial-title">
          <h3 id="trial-title">Start with a free chat</h3>
          <p>Open your visitor link, send a question and reply from your team inbox.</p>
          <LandingActions id="start-install" />
          <p className={styles.allowance}>Try {PRODUCT_LIMITS.freeSupportTickets} tickets with up to {PRODUCT_LIMITS.freeTeamRepliesPerTicket} staff replies each. Templ AI is off during the trial.</p>
        </section>
        <section className={styles.hosted} aria-labelledby="hosted-title">
          <h3 id="hosted-title">Templ Hosted</h3>
          <p>
            When you’re ready, choose an available name and pay monthly or annually in USDC.
            Both plans include hosting, storage and all team seats. Renew manually.
          </p>
          <table aria-label="Templ Hosted plans">
            <thead><tr><th scope="col">Plan</th><th scope="col">Starter</th><th scope="col">Plus</th></tr></thead>
            <tbody>
              <tr className={styles.price}><th scope="row">Per month</th><td>{dollars(STARTER.workspaceMonthlyUsdCents)}</td><td>{dollars(PLUS.workspaceMonthlyUsdCents)}</td></tr>
              <tr><th scope="row">Per year · 2 months free</th><td>{dollars(ANNUAL.starter)}</td><td>{dollars(ANNUAL.standard)}</td></tr>
              <tr><th scope="row">Cases per month</th><td>{STARTER.includedAnsweredCasesPerMonth}</td><td>{PLUS.includedAnsweredCasesPerMonth}</td></tr>
              <tr><th scope="row">Each extra case</th><td>{dollars(STARTER.additionalAnsweredCaseUsdCents)}</td><td>{dollars(PLUS.additionalAnsweredCaseUsdCents)}</td></tr>
              <tr><th scope="row">AI credit per month</th><td>{dollars(STARTER.includedAiCreditUsdCents)}</td><td>{dollars(PLUS.includedAiCreditUsdCents)}</td></tr>
            </tbody>
          </table>
          <p className={styles.allowance}>Bring your own AI provider or prepay for Templ AI with a spending limit.</p>
        </section>
      </div>
      <small className={styles.footnote}><a href={SITE.docs + "/pricing"} data-templ-conversion="pricing_rules_clicked">Full pricing details</a></small>
    </section>
  );
}
