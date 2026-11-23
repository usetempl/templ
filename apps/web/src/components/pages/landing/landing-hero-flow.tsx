"use client";
import { SupportWidgetDemo } from "@/components/support-widget-demo";
import { brandAsset } from "@/lib/brand-assets";
import { TemplSupportLink } from "@/components/templ-support";
import styles from "./landing-page.module.css";

/** A static view of the installed renderer, opening the real conversation. */
export function LandingHeroFlow() {
  return (
    <figure className={styles.conversation}>
      <div className={styles.heroWidget} data-testid="hero-widget-panel">
        <div className={styles.previewSurface} inert>
          <SupportWidgetDemo
            className={styles.inlineWidget}
            label="Templ"
            scenario="conversation"
            presentation
            appearance={{
              logo: brandAsset("/art/brand/templ-square.svg"),
              theme: "auto",
              radius: "soft",
            }}
          />
        </div>
        <TemplSupportLink className={styles.previewAction}>
          <span>Try the chat</span>
        </TemplSupportLink>
      </div>
    </figure>
  );
}
