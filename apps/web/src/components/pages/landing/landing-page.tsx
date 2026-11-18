"use client";

import { SiteFooter, SiteHeader } from "@/components/site-frame";
import { LandingHeroFlow } from "./landing-hero-flow";
import { LANDING_PREVIEW, LANDING_PREVIEW_BANNER } from "@/lib/landing-preview";
import { LandingActions } from "./landing-install";
import { LandingPricing } from "./landing-pricing";
import { LandingResults } from "./landing-results";
import { LandingStory } from "./landing-story";
import styles from "./landing-page.module.css";

export const CLOSE_TITLE = "Give your users a place to talk.";
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
                Support that respects your privacy
              </h1>
              <p className={styles.subline}>
                Help inside your app. Your users choose what to share.
              </p>
              <LandingActions id="hero-chat" />
            </div>
            <div className={styles.heroFrame}>
              <LandingHeroFlow />
            </div>
          </div>
        </section>
        <LandingStory />
        <LandingPricing />
        <LandingResults />
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
