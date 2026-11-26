import Link from "next/link";
import { SITE } from "@/lib/config";
import styles from "./page.module.css";

export const metadata = { title: "Add Templ chat or connect your AI agent", description: "Share a chat link, embed the widget or connect your own AI to the team inbox." };

export default function IntegrationPage() {
  return (
    <section className={styles.page} aria-labelledby="integration-title">
      <h1 id="integration-title">Build support into your app</h1>
      <p>
        Share a chat link or add the widget to your site. Visitors can ask as guests.
        Both routes send messages to your team inbox.
      </p>
      <div className={styles.actions}>
        <Link href="/create" className="button">
          Create your chat
        </Link>
        <a href={`${SITE.docs}/developers/widget`} className="button secondary">
          Widget guide
        </a>
      </div>
      <div className={styles.agent}>
        <h2>Connect your AI agent</h2>
        <p>Use the agent client to read cases and send replies through your own model.</p>
        <a href={`${SITE.docs}/developers/support-agent`}>
          Read the agent guide
        </a>
      </div>
    </section>
  );
}
