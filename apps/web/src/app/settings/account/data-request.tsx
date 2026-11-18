import Link from "next/link";
import { TalkToTempl } from "@/components/talk-to-templ";
import styles from "./data-request.module.css";

/** Ask about your data: Templ's own chat with a data question ready, or an
 * email when the chat can't open here. A person answers. */
export function DataRequest() {
  return (
    <section className={styles.section} aria-labelledby="data-request-title">
      <h2 id="data-request-title">Your data</h2>
      <p>
        Ask for a copy, correction or deletion of your data. A person on the
        Templ team answers. Deleting an account isn&apos;t self-serve yet.
      </p>
      <div className={styles.actions}>
        <TalkToTempl
          topic="privacy"
          label="Ask about your data"
          className={styles.action}
        >
          Ask about your data
        </TalkToTempl>
        <Link href="/trust#retention">How long Templ keeps data</Link>
      </div>
    </section>
  );
}
