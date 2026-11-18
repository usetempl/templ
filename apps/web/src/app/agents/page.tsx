import Link from "next/link";
import { SITE } from "@/lib/config";
import styles from "./page.module.css";

export const metadata = { title: "Support integration" };

export default function IntegrationPage() {
  return (
    <section className={styles.page} aria-labelledby="integration-title">
      <h1 id="integration-title">Build support into your app</h1>
      <p>
        Add the Templ widget to your app. Users can ask without signing in,
        unless your team requires a wallet. Wallet verification uses a separate
        sign-in message.
      </p>
      <div className={styles.actions}>
        <Link href="/create" className="button">
          Create workspace
        </Link>
        <a href={`${SITE.docs}/developers/widget`} className="button secondary">
          Widget guide
        </a>
      </div>
      <div className={styles.agent}>
        <h2>Build an AI agent</h2>
        <p>Connect your AI agent to the same cases your team answers.</p>
        <a href={`${SITE.docs}/developers/support-agent`}>
          Read the agent guide
        </a>
      </div>
    </section>
  );
}
