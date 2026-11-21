"use client";

import { useEffect, useState } from "react";
import { IconArrowRight } from "@tabler/icons-react";
import { TEMPL_SOURCE_URL } from "./landing-install";
import styles from "./landing-story.module.css";

export function LandingStory() {
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [run, setRun] = useState(0);
  const [shared, setShared] = useState({ transaction: true, wallet: false });

  useEffect(() => {
    if (!form || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setRun(value => value || 1);
        observer.disconnect();
      }
    }, { threshold: 0.3 });
    observer.observe(form);
    return () => observer.disconnect();
  }, [form]);

  return (
    <section id="how" className={styles.story} aria-labelledby="story-title">
      <div id="story" className={styles.intro}>
        <h2 id="story-title">What goes into a support ticket?</h2>
        <p>Try a failed swap. Choose the details to include and see what reaches the team.</p>
      </div>
      <div className={styles.stage} aria-label="Interactive Standard chat example">
        <form className={styles.visitor} ref={setForm} onSubmit={event => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          setShared({ transaction: fields.has("transaction"), wallet: fields.has("wallet") });
          setRun(value => value + 1);
        }}>
          <h3>Visitor chat</h3>
          <p className={styles.bubble}>My swap failed. Can you check what happened?</p>
          <fieldset>
            <legend>Share with support</legend>
            <label><input type="checkbox" name="transaction" defaultChecked />
              Transaction hash <code>0x8e2a…b730</code></label>
            <label><input type="checkbox" name="wallet" />
              Wallet address <code>0x71c4…9a2f</code></label>
          </fieldset>
          <button type="submit" className={styles.send} disabled={!form}>
            Send example <IconArrowRight size={16} aria-hidden="true" />
          </button>
        </form>
        <div key={run} className={styles.delivery} data-play={run > 0 || undefined}>
          <span className={styles.track} aria-hidden="true"><i /></span>
          <div className={styles.inbox}>
            <h3>Team inbox <span>Standard chat</span></h3>
            <div className={styles.receipt} aria-live="polite">
              <strong>Failed swap</strong>
              <p>My swap failed. Can you check what happened?</p>
              <dl>
                <div><dt>Transaction</dt><dd>{shared.transaction ? "0x8e2a…b730" : "Omitted"}</dd></div>
                <div><dt>Wallet</dt><dd>{shared.wallet ? "0x71c4…9a2f" : "Omitted"}</dd></div>
              </dl>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.details}>
        <div><h3>Who can read this ticket?</h3>
          <p>The visitor, staff with access and the server operator can read a Standard chat. An AI responder can read it when the case allows AI. A public transaction hash can also reveal addresses onchain.</p></div>
        <div><h3>Inspect it or run it yourself</h3>
          <p>The MIT source includes the visitor chat, staff inbox and support worker. Follow a message through the code or run the app on your own servers.</p>
          <a href={TEMPL_SOURCE_URL + "#try-a-complete-conversation"}>Open the source and quick start</a></div>
      </div>
    </section>
  );
}
