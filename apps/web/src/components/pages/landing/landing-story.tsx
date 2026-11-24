import type { CSSProperties } from "react";
import { SupportWidgetDemo } from "@/components/support-widget-demo";
import { TemplMark } from "@/components/brand/templ-mark";
import { transactionExample } from "@/lib/standalone-trial-example";
import styles from "./landing-story.module.css";

const readers = ["The visitor", "Authorized staff", "The server operator", "A permitted AI responder"];

export function LandingStory() {
  return (
    <figure id="how" className={styles.stage} aria-label="Example conversation">
      <figcaption>Example</figcaption>
      <div id="story" className={styles.transcript}>
        <div className={styles.markLine} aria-hidden="true"><TemplMark decorative className={styles.mark} /><span /></div>
        <SupportWidgetDemo className={styles.widget} scenario="shared-transaction" presentation
          appearance={{ theme: "auto", radius: "soft", accent: { light: "#727272", dark: "#cccccc" } }}>
          <ol className={styles.firstPaint} aria-label="Example messages">
            <li><small>Visitor chat</small>{transactionExample.question}</li>
            <li><small>Team inbox</small>{transactionExample.reply}</li>
          </ol>
        </SupportWidgetDemo>
      </div>
      <p className={styles.payoff}>Answered with no wallet connected.</p>
    </figure>
  );
}

export function StandardReaders() {
  return (
    <section id="readers" className={styles.readers} aria-labelledby="readers-title">
      <div className={styles.readersInner}>
        <h2 id="readers-title">Who can read a Standard chat</h2>
        <div className={styles.track}>
          <div className={styles.rail} aria-hidden="true"><span className={styles.traveller}>My deposit failed.</span></div>
          <ul>
            {readers.map((reader, i) => <li key={reader} style={{ "--station-end": (5 + 30 * i) + "%", "--station-start": (30 * i) + "%" } as CSSProperties}>{reader}</li>)}
          </ul>
        </div>
        <p>AI can read messages when the workspace and the case allow it. If a visitor shares a public transaction, it may reveal their wallet onchain.</p>
      </div>
    </section>
  );
}
