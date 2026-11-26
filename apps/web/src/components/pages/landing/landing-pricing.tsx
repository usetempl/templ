import { PRODUCT_ANNUAL_PRICES as ANNUAL, PRODUCT_LIMITS, PRODUCT_STARTER_PRICES as STARTER, PRODUCT_STANDARD_PRICES as PLUS } from "@templ/chat/plans";
import { formatUsdCents as dollars } from "@templ/chat/resolution-copy";
import { SITE } from "@/lib/site-environment";
import { CustomPricingLink } from "./landing-custom-pricing";
import { LandingActions } from "./landing-install";
import styles from "./landing-pricing.module.css";

const exampleCases = 2_000;
const exampleMonthlyCents = PLUS.workspaceMonthlyUsdCents
  + (exampleCases - PLUS.includedAnsweredCasesPerMonth) * PLUS.additionalAnsweredCaseUsdCents;

export function LandingPricing() {
  return (
    <section id="pricing" className={styles.plans} aria-labelledby="pricing-title">
      <h2 id="pricing-title">Claim your custom URL</h2>
      <div className={styles.choices}>
        <section id="install" className={styles.trial} aria-labelledby="trial-title">
          <h3 id="trial-title">Start with a free chat</h3>
          <p>Add your docs and ask AI {PRODUCT_LIMITS.freeAiPracticeQuestions} private questions.</p>
          <LandingActions id="start-install" />
          <p className={styles.allowance}>Try {PRODUCT_LIMITS.freeSupportTickets} tickets with up to {PRODUCT_LIMITS.freeTeamRepliesPerTicket} staff replies each.</p>
        </section>
        <section className={styles.hosted} aria-labelledby="hosted-title">
          <h3 id="hosted-title">Templ Hosted</h3>
          <p>Both plans include hosting, storage and all team seats. Renew manually.</p>
          <table aria-label="Templ Hosted plans">
            <thead><tr><th scope="col">Plan</th><th scope="col">Starter</th><th scope="col">Plus</th></tr></thead>
            <tbody>
              <tr className={styles.price}><th scope="row">Per month</th><td>{dollars(STARTER.workspaceMonthlyUsdCents)}</td><td>{dollars(PLUS.workspaceMonthlyUsdCents)}</td></tr>
              <tr><th scope="row">Per year · 2 months free</th><td>{dollars(ANNUAL.starter)}</td><td>{dollars(ANNUAL.standard)}</td></tr>
              <tr><th scope="row">Answered cases included monthly</th><td>{STARTER.includedAnsweredCasesPerMonth}</td><td>{PLUS.includedAnsweredCasesPerMonth}</td></tr>
              <tr><th scope="row">More cases on demand</th><td>{dollars(STARTER.additionalAnsweredCaseUsdCents)} each</td><td>{dollars(PLUS.additionalAnsweredCaseUsdCents)} each</td></tr>
              <tr><th scope="row">Monthly AI credit</th><td>{dollars(STARTER.includedAiCreditUsdCents)}</td><td>{dollars(PLUS.includedAiCreditUsdCents)}</td></tr>
            </tbody>
          </table>
          <p className={styles.example}>
            On Plus, {exampleCases.toLocaleString("en-US")} answered cases in one month cost {dollars(exampleMonthlyCents)} before extra AI usage.{" "}
            <CustomPricingLink />
          </p>
        </section>
      </div>
      <small className={styles.footnote}>Top up anytime for more cases or AI. <a href={SITE.docs + "/pricing"} data-templ-conversion="pricing_rules_clicked">Full pricing details</a></small>
    </section>
  );
}
