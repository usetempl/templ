import { IconInbox, IconMessage, IconMessageReply } from "@tabler/icons-react";
import { SupportWidgetDemo } from "@/components/support-widget-demo";
import { TemplMark } from "@/components/brand/templ-mark";
import { transactionExample } from "@/lib/standalone-trial-example";
import styles from "./landing-story.module.css";

const readers = [
  { name: "The visitor", access: "Sends and reads the message.", icon: IconMessage },
  { name: "Authorized staff and the server operator", access: "Can read the message text.", icon: IconInbox },
  { name: "An AI responder", access: "Can read it if the workspace and the case allow it.", icon: IconMessageReply },
];

export function LandingStory() {
  return (
    <figure id="how" className={styles.stage} aria-label="Example conversation">
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
          <ol>
            {readers.map(({ name, access, icon: Icon }) => (
              <li key={name}>
                <span className={styles.square} aria-hidden="true" />
                <h3>{name}</h3>
                <div className={styles.step}>
                  <span className={styles.stamp} aria-hidden="true"><Icon stroke={1.75} /></span>
                  <span>{access}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
