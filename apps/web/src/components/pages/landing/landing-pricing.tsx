import {
  PRODUCT_LIMITS,
  PRODUCT_STARTER_PRICES as STARTER,
  PRODUCT_STANDARD_PRICES as PLUS,
} from "@templ/chat/plans";
import { formatUsdCents as dollars } from "@templ/chat/resolution-copy";
import { TEMPL_SOURCE_URL } from "./landing-install";
import { SITE } from "@/lib/site-environment";
import styles from "./landing-pricing.module.css";

export function LandingPricing() {
  return (
    <section id="pricing" className={styles.plans} aria-labelledby="pricing-title">
      <h2 id="pricing-title">Try both sides before you pay</h2>
      <div className={styles.choices}>
        <section id="install" className={styles.self} aria-labelledby="trial-title">
          <h3 id="trial-title">Your free test</h3>
          <p>Open your trial link, send a question, then answer it from your inbox. You get {PRODUCT_LIMITS.freeSupportTickets} test tickets with up to {PRODUCT_LIMITS.freeTeamRepliesPerTicket} staff replies per ticket. Templ AI is off during the test.</p>
          <p>Add the widget to your site later if you want a second way into the same inbox.</p>
        </section>
        <section className={styles.hosted} aria-labelledby="hosted-title">
          <h3 id="hosted-title">Templ Hosted</h3>
          <p>Claim an available hosted name whenever you’re ready. Each USDC payment covers one month of service for your workspace, including your chat, inbox, storage and all team seats. Renew manually.</p>
          <table aria-label="Templ Hosted monthly plans">
            <thead><tr><th scope="col" className={styles.planLabel}>Plan</th><th scope="col">Starter</th><th scope="col">Plus</th></tr></thead>
            <tbody>
              <tr className={styles.price}><th scope="row">Per month</th><td>{dollars(STARTER.workspaceMonthlyUsdCents)}</td><td>{dollars(PLUS.workspaceMonthlyUsdCents)}</td></tr>
              <tr><th scope="row">Answered cases</th><td>{STARTER.includedAnsweredCasesPerMonth}</td><td>{PLUS.includedAnsweredCasesPerMonth}</td></tr>
              <tr><th scope="row">Each extra case</th><td>{dollars(STARTER.additionalAnsweredCaseUsdCents)}</td><td>{dollars(PLUS.additionalAnsweredCaseUsdCents)}</td></tr>
              <tr><th scope="row">Templ AI credit</th><td>{dollars(STARTER.includedAiCreditUsdCents)}</td><td>{dollars(PLUS.includedAiCreditUsdCents)}</td></tr>
            </tbody>
          </table>
          <p>AI is optional. Bring your own provider or prepay for Templ AI and set a spending limit.</p>
          <a href={SITE.docs + "/pricing"} data-templ-conversion="pricing_rules_clicked">Compare plan details</a>
        </section>
      </div>
      <p className={styles.contactLine}>Self-host the MIT app to serve support on your own domain. You run the infrastructure.{" "}
        <a href={TEMPL_SOURCE_URL + "#try-a-complete-conversation"}>Open the quick start</a>
      </p>
    </section>
  );
}
