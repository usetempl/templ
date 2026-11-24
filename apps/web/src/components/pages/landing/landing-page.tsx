"use client";

import { SiteFooter, SiteHeader } from "@/components/site-frame";
import { TemplSupportLink } from "@/components/templ-support";
import { SITE } from "@/lib/site-environment";
import { LANDING_PREVIEW, LANDING_PREVIEW_BANNER } from "@/lib/landing-preview";
import { LandingActions, TEMPL_SOURCE_URL } from "./landing-install";
import { LandingPricing } from "./landing-pricing";
import { LandingStory, StandardReaders } from "./landing-story";
import styles from "./landing-page.module.css";

export function LandingPage() {
  return (
    <div className={styles.page}>
      {LANDING_PREVIEW && <p className={styles.preview} role="note">{LANDING_PREVIEW_BANNER}</p>}
      <SiteHeader brandOnly />
      <main id="main-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.heroInner}>
            <h1 id="landing-title" className={styles.heroTitle}>A secure support line for apps that care about anonymity.</h1>
            <div className={styles.heroCopy}>
              <p className={styles.subline}>A visitor can ask for help without connecting a wallet. Try your own line and inbox free.</p>
              <LandingActions id="hero-chat" selfHost />
            </div>
            <LandingStory />
          </div>
        </section>
        <StandardReaders />
        <LandingPricing />
        <section id="start" className={styles.close} aria-labelledby="start-title">
          <h2 id="start-title">Run Templ on your own domain</h2>
          <p>Templ is MIT licensed.</p>
          <nav aria-label="Self-hosting and help">
            <a href={TEMPL_SOURCE_URL + "#try-a-complete-conversation"}>Self-host Templ</a>
            <a href={SITE.docs + "/setup"}>Read the docs</a>
            <TemplSupportLink className={styles.helpLink}>Talk to us</TemplSupportLink>
          </nav>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
