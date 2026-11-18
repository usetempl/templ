import type { Metadata } from "next";
import styles from "@/components/workspace/workspace-alerts.module.css";
import { MemberAlerts } from "./member-alerts";

export const metadata: Metadata = {
  title: "Reply emails",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Where a signed member turns on an email for the team's replies. The
 * link from the widget carries a one-time ticket in its fragment. */
export default function AlertsPage() {
  return (
    <main className={styles.page}>
      <MemberAlerts />
    </main>
  );
}
