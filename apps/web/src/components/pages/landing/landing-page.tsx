"use client";

import hero from "./hero-copy.json";
import Link from "next/link";
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
          <svg className={styles.homeServer} viewBox="0 0 320 180" role="img" aria-label="A server in slippers holds a coffee mug and says, I work from home.">
            <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path className={styles.serverPaper} d="M158 12h129a12 12 0 0 1 12 12v17a12 12 0 0 1-12 12H174l-20 13 5-13h-1a12 12 0 0 1-12-12V24a12 12 0 0 1 12-12z" />
              <text x="222" y="38" textAnchor="middle" fill="currentColor" stroke="none">I work from home.</text>
              <path d="m101 135-3 17m36-16 5 16m-64-56q-10 8-13 19t15 14m81-30q13 19 31 12" />
              <path className={styles.serverPaper} d="M75 67 86 55h67l9 9v64l-10 11H84l-9-9z" />
              <path d="M76 68h76l9-4m-9 5v69" />
              <rect x="84" y="77" width="60" height="31" rx="6" />
              <path d="M94 90q3-5 7 0m24 0q3-5 7 0m-26 5q6 8 13-1" />
              <path d="M87 119h29m-29 7h17" />
              <circle className={styles.serverLight} cx="136" cy="122" r="3.2" />
              <path className={styles.serverShoe} d="M86 148q7-6 15 0l3 6c9-3 18 1 18 9l-1 3H83q-4-9 3-18zM133 148q8-5 14 2l4 4c9-3 19 1 20 9l-2 3h-38q-5-10 2-18z" />
              <path d="m87 158 5 3m46-3 5 3m-57 9h35m12 0h38" />
              <path className={styles.serverPaper} d="M182 97h24l-2 18q-1 6-10 6t-10-6z" />
              <path d="M206 99q12-3 9 5-2 5-10 5m-19-18q-4-4 0-8m9 8q4-5-1-10" />
            </g>
          </svg>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
