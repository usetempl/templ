import { PRODUCT_LIMITS, PRODUCT_STARTER_PRICES as STARTER, PRODUCT_STANDARD_PRICES as PLUS } from "@templ/chat/plans";
import { formatUsdCents as dollars } from "@templ/chat/resolution-copy";
import { SITE } from "@/lib/site-environment";
import { LandingActions } from "./landing-install";
import styles from "./landing-pricing.module.css";

export function LandingPricing() {
  return (
    <section id="pricing" className={styles.plans} aria-labelledby="pricing-title">
      <h2 id="pricing-title">Try it free. Pay to claim your name.</h2>
      <div className={styles.choices}>
        <section id="install" aria-labelledby="trial-title">
          <h3 id="trial-title">Your free test</h3>
          <p>Try your own chat link and team inbox. You get {PRODUCT_LIMITS.freeSupportTickets} tickets with up to {PRODUCT_LIMITS.freeTeamRepliesPerTicket} staff replies each. Templ AI is off during the trial.</p>
          <p>You can add a widget to your site later.</p>
          <LandingActions id="start-install" />
        </section>
        <section className={styles.hosted} aria-labelledby="hosted-title">
          <h3 id="hosted-title">Templ Hosted</h3>
          <p>Pay monthly in USDC to claim an available hosted name. Chat, storage and all team seats are included. Renew manually.</p>
          <table aria-label="Templ Hosted monthly plans">
            <thead><tr><th scope="col">Plan</th><th scope="col">Starter</th><th scope="col">Plus</th></tr></thead>
            <tbody>
              <tr className={styles.price}><th scope="row">Per month</th><td>{dollars(STARTER.workspaceMonthlyUsdCents)}</td><td>{dollars(PLUS.workspaceMonthlyUsdCents)}</td></tr>
              <tr><th scope="row">Answered cases</th><td>{STARTER.includedAnsweredCasesPerMonth}</td><td>{PLUS.includedAnsweredCasesPerMonth}</td></tr>
              <tr><th scope="row">Each extra case</th><td>{dollars(STARTER.additionalAnsweredCaseUsdCents)}</td><td>{dollars(PLUS.additionalAnsweredCaseUsdCents)}</td></tr>
              <tr><th scope="row">Templ AI credit</th><td>{dollars(STARTER.includedAiCreditUsdCents)}</td><td>{dollars(PLUS.includedAiCreditUsdCents)}</td></tr>
            </tbody>
          </table>
          <p>AI is optional. Connect your provider or prepay for Templ AI with a spending limit.</p>
          <a href={SITE.docs + "/pricing"} data-templ-conversion="pricing_rules_clicked">Compare plan details</a>
        </section>
      </div>
    </section>
  );
}
