"use client";

import { SiteFooter, SiteHeader } from "@/components/site-frame";
import { PRODUCT_LIMITS, PRODUCT_STARTER_PRICES } from "@templ/chat/plans";
import { formatUsdCents } from "@templ/chat/resolution-copy";
import { LANDING_PREVIEW, LANDING_PREVIEW_BANNER } from "@/lib/landing-preview";
import { LandingActions } from "./landing-install";
import { LandingPricing } from "./landing-pricing";
import { LandingStory } from "./landing-story";
import styles from "./landing-page.module.css";

export const CLOSE_TITLE = "Open your team’s support line.";
export function LandingPage() {
  return (
    <div className={styles.page}>
      {LANDING_PREVIEW && (
        <p className={styles.preview} role="note">
          {LANDING_PREVIEW_BANNER}
        </p>
      )}
      <SiteHeader brandOnly />
      <main id="main-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <h1 id="landing-title" className={styles.heroTitle}>
                Crypto support where visitors choose what to share
              </h1>
              <p className={styles.subline}>
                Share one chat link. Visitors can ask without connecting a wallet. Your team answers from one inbox.
              </p>
              <LandingActions id="hero-chat" />
              <p className={styles.terms}>Try {PRODUCT_LIMITS.freeSupportTickets} tickets free. Hosted plans start at {formatUsdCents(PRODUCT_STARTER_PRICES.workspaceMonthlyUsdCents)} per month, paid in USDC.</p>
            </div>
          </div>
        </section>
        <LandingStory />
        <LandingPricing />
        <section
          id="start"
          className={styles.close}
          aria-labelledby="start-title"
        >
          <div className={styles.closeInner}>
            <h2 id="start-title">{CLOSE_TITLE}</h2>
            <LandingActions id="start-install" tone="band" />
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
