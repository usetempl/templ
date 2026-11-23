import { SupportWidgetDemo } from "@/components/support-widget-demo";
import { transactionExample } from "@/lib/standalone-trial-example";
import styles from "./landing-story.module.css";

export function LandingStory() {
  return (
    <section id="how" className={styles.story} aria-labelledby="story-title">
      <div id="story" className={styles.intro}>
        <h2 id="story-title">A failed deposit, from chat to inbox</h2>
        <p>In this example, the visitor chooses to share a transaction without connecting a wallet. The team replies in the same chat.</p>
      </div>
      <div className={styles.stage}>
        <div className={styles.visitor}>
          <h3>Visitor chat</h3>
          <dl className={styles.sharedDetails} aria-label="Visitor’s sharing choices">
            <div><dt>Share transaction</dt><dd>{transactionExample.network} {transactionExample.transaction}</dd></div>
            <div><dt>Connect wallet</dt><dd>Skipped</dd></div>
          </dl>
          <SupportWidgetDemo className={styles.exampleChat} scenario="shared-transaction" presentation
            appearance={{ theme: "auto", radius: "soft" }} />
        </div>
        <section className={styles.inbox} aria-label="Example team inbox">
          <h3>Team inbox <span>Standard chat</span></h3>
          <article className={styles.receipt}>
            <strong>Failed deposit</strong>
            <p>{transactionExample.question}</p>
            <dl>
              <div><dt>Transaction</dt><dd>{transactionExample.network} {transactionExample.transaction}</dd></div>
              <div><dt>Wallet</dt><dd>Not connected</dd></div>
            </dl>
            <p><strong>Team reply</strong></p>
            <p>{transactionExample.reply}</p>
          </article>
        </section>
      </div>
      <p className={styles.readers}>The visitor, staff with inbox access and the server operator can read Standard chat. An AI responder can read it when the workspace and case allow AI. A public transaction may reveal a wallet address onchain.</p>
    </section>
  );
}
