import Link from "next/link";
import {
  PRODUCT_LIMITS,
  PRODUCT_STARTER_PRICES as STARTER,
  PRODUCT_STANDARD_PRICES as PLUS,
} from "@templ/chat/plans";
import { formatUsdCents as dollars } from "@templ/chat/resolution-copy";
import { TemplSupportLink } from "@/components/templ-support";
import { InstallPromptButton, TEMPL_SOURCE_URL } from "./landing-install";
import { SITE } from "@/lib/site-environment";
import styles from "./landing-pricing.module.css";

export function LandingPricing() {
  return (
    <section id="pricing" className={styles.plans} aria-labelledby="pricing-title">
      <h2 id="pricing-title">Where do you want to run Templ?</h2>
      <div className={styles.choices}>
        <section className={styles.self} aria-labelledby="self-host-title">
          <h3 id="self-host-title">Self-host Templ</h3>
          <p>Run the MIT app on your own servers. You pay for the infrastructure you use.</p>
          <a href={TEMPL_SOURCE_URL + "#try-a-complete-conversation"} className={styles.contact}>Open the self-host quick start</a>
        </section>
        <section className={styles.hosted} aria-labelledby="hosted-title">
          <h3 id="hosted-title">Templ Hosted</h3>
          <p>Templ runs your chat, staff inbox and message storage. Both paid plans include all seats.</p>
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
          <div id="install" className={styles.trial}>
            <h4>Try {PRODUCT_LIMITS.freeSupportTickets} tickets free</h4>
            <p>Test the widget and reply from the inbox. The free test uses staff replies.</p>
            <Link href="/create?next=plan" className={styles.contact}>Start a hosted workspace</Link>
            <InstallPromptButton className={styles.installPrompt} />
          </div>
        </section>
      </div>
      <p className={styles.contactLine}>Need a custom integration or want Templ to run your support? <TemplSupportLink className={styles.help}>Talk to us</TemplSupportLink></p>
    </section>
  );
}
