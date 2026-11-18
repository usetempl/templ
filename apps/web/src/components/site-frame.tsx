"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { TemplLogo } from "@/components/brand/templ-mark";
import { TalkToTempl } from "@/components/talk-to-templ";
import { SITE } from "@/lib/release-public";
import styles from "./site-frame.module.css";

export function SiteHeader({ brandOnly = false }: { brandOnly?: boolean }) {
  const landing = usePathname() === "/";
  const section = (id: string) => (landing ? `#${id}` : `/#${id}`);
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.brand} aria-label="Templ home">
          <TemplLogo className={styles.logo} lockup />
        </Link>
        {brandOnly && (
          <div className={`${styles.headerActions} ${styles.landingActions}`}>
            <Link href="/inbox" className={styles.landingApp}>
              Open app
            </Link>
          </div>
        )}
        {!brandOnly && (
          <nav className={styles.nav} aria-label="Main navigation">
            <a href={section("how")}>How it works</a>
            <a href={section("pricing")}>Pricing</a>
            <a href={SITE.docs}>Docs</a>
          </nav>
        )}
        {!brandOnly && (
          <div className={styles.headerActions}>
            <Link href="/inbox" className={styles.signIn}>
              Open app
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}

/** The public site's footer. The landing page carries no availability
 * link; every other page links What’s live. */
export function SiteFooter() {
  const landing = usePathname() === "/";
  const section = (id: string) => (landing ? `#${id}` : `/#${id}`);
  return (
    <footer className={styles.footer}>
      <div className={styles.footerBrand}>
        <TemplLogo className={styles.footerLogo} lockup />
        <p>
          {landing
            ? "Support for apps and users who care about privacy."
            : "Wallet and transaction support for DeFi apps."}
        </p>
      </div>
      <nav aria-label="Footer" className={styles.footerNav}>
        <div>
          <p>Product</p>
          <a href={section("how")}>How it works</a>
          <a href={section("pricing")}>Pricing</a>
          <Link href="/trust">Security</Link>
          {!landing && <Link href="/availability">What’s live</Link>}
        </div>
        <div>
          <p>Developers</p>
          <a href={SITE.docs}>Docs</a>
          <a href={`${SITE.docs}/widget`}>Widget guide</a>
          <a href={`${SITE.docs}/developers/support-agent`}>AI agents</a>
        </div>
        <div>
          <p>Company</p>
          <a href={SITE.blog}>Blog</a>
          <Link href="/chief">Chief setup</Link>
          {!landing && (
            <TalkToTempl className={styles.footerButton} label="Talk to us">
              Talk to us
            </TalkToTempl>
          )}
          <Link href="/trust">Trust</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/dpa">DPA</Link>
          <Link href="/safety">Safety</Link>
        </div>
      </nav>
    </footer>
  );
}

/** Policy and information pages share the landing page's header and footer. */
export function SiteFrame({ children }: { children: ReactNode }) {
  const appPage = ["/agents", "/availability", "/alerts", "/status"].includes(
    usePathname(),
  );
  return (
    <div className={styles.frame} data-app-readability={appPage || undefined}>
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
