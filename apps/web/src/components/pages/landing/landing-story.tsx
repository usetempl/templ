import styles from "./landing-story.module.css";

export function LandingStory() {
  return (
    <section id="how" className={styles.story} aria-labelledby="story-title">
      <div className={styles.copy} id="story">
        <h2 id="story-title">Cases arrive ready to answer.</h2>
        <p>
          Users review their details before sending. Your team gets the context
          they choose to share.
        </p>
      </div>
      <article className={styles.example} aria-label="Example case">
        <p className={styles.label}>Example case</p>
        <h3>Sent 0.4 ETH. Never arrived.</h3>
        <dl>
          <div>
            <dt>Wallet</dt>
            <dd>0x71C4…9A2f</dd>
          </div>
          <div>
            <dt>Chain</dt>
            <dd>Base</dd>
          </div>
          <div>
            <dt>Transaction</dt>
            <dd>0x8e2a…b730</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>Failed · Out of gas</dd>
          </div>
        </dl>
        <p className={styles.answer}>
          Your 0.4 ETH is still in your wallet. Only the gas fee was spent.
        </p>
      </article>
    </section>
  );
}
