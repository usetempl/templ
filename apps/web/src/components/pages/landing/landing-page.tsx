"use client";

import hero from "./hero-copy.json";
import cryptoDesk from "@/lib/crypto-desk-copy.json";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef } from "react";
import { TemplSupport } from "@/components/templ-support";
import { SiteFooter, SiteHeader } from "@/components/site-frame";
import { SITE } from "@/lib/site-environment";
import { LANDING_PREVIEW, LANDING_PREVIEW_BANNER } from "@/lib/landing-preview";
import { LandingActions, TEMPL_SOURCE_URL } from "./landing-install";
import { LandingPricing } from "./landing-pricing";
import { LandingStory, SupportStory } from "./landing-story";
import styles from "./landing-page.module.css";

export function LandingPage() {
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!page.current || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-in-view", "");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.35 });
    page.current.querySelectorAll("[data-route-step]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);
  return (
    <div className={styles.page} data-theme="light" ref={page}>
      {LANDING_PREVIEW && <p className={styles.preview} role="note">{LANDING_PREVIEW_BANNER}</p>}
      <TemplSupport lockedTheme="light" showLauncher />
      <SiteHeader brandOnly />
      <main id="main-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.heroInner}>
            <h1 id="landing-title" className={styles.heroTitle}>{hero.headline}</h1>
            <div className={styles.heroCopy}>
              <p className={styles.subline}>
                {hero.description[0]}{" "}<br />
                {hero.description[1]}
              </p>
              <LandingActions id="hero-chat" selfHost />
            </div>
            <LandingStory />
          </div>
        </section>
        <SupportStory />
        <section id="crypto-help" className={styles.cryptoDesk} aria-labelledby="crypto-help-title">
          <div className={styles.cryptoInner}>
            <h2 id="crypto-help-title">{cryptoDesk.headline}</h2>
            <div>
              <p>We built a free crypto help desk for everyone. Ask in your own language about backing up your first wallet or checking a pending transfer.</p>
              <a className={styles.cryptoLink} href="https://usetempl.com/crypto">Ask a crypto question <span aria-hidden="true">→</span></a>
              <p className={styles.cryptoSource}>Add private support to your app with <a href={TEMPL_SOURCE_URL}>open-source Templ</a>.</p>
            </div>
          </div>
        </section>
        <LandingPricing />
        <section id="start" className={styles.close} aria-labelledby="start-title">
          <div>
          <h2 id="start-title">Run Templ on your own domain</h2>
          <p>
            Run the MIT-licensed app on your infrastructure.{" "}<br />
            Your support link uses your domain.
          </p>
          <nav aria-label="Start using Templ">
            <a href={TEMPL_SOURCE_URL + "#try-a-complete-conversation"}>Self-host Templ</a>
            <a href={SITE.docs + "/setup"}>Read the docs</a>
            <Link className={styles.helpLink} href="/create">Try cloud</Link>
          </nav>
          </div>
          <figure className={styles.comic}>
            <Image src="/art/guest-at-the-window.svg" width={560} height={420}
              alt="A guest in an enormous trench coat knocks at a tiny support window. Only their eyes show."
              loading="lazy" unoptimized />
            <figcaption>
              <span>“Who’s there?”</span>
              <span>“Rather not say.”</span>
              <span>“Fair enough. How can I help?”</span>
            </figcaption>
          </figure>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
