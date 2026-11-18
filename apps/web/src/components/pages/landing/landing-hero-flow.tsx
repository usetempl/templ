"use client";
import { SupportWidgetDemo } from "@/components/support-widget-demo";
import { brandAsset } from "@/lib/brand-assets";
import { TemplSupportButton } from "@/components/templ-support";
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
              theme: "light",
              radius: "soft",
              accent: "#99FF00",
            }}
          />
        </div>
        <TemplSupportButton
          className={styles.previewAction}
          label="Try the chat"
          conversion="talk_to_us_clicked"
        />
      </div>
      <figcaption>Example conversation</figcaption>
    </figure>
  );
}
