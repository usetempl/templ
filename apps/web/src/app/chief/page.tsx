import type { Metadata } from "next";
import { ChiefGuide } from "./guide";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Chief setup guide",
  description:
    "Set up Chief in Codex or Claude Code, read your private project board, and continue the same conversation from Dot or another device.",
  alternates: { canonical: "/chief" },
};

export default function ChiefPage() {
  return (
    <div className={styles.page}>
      <nav className={styles.contents} aria-label="Chief guide">
        <span>Chief setup</span>
        <a href="#start-your-own-chief">Install</a>
        <a href="#use-dot-or-mobile">Dot / mobile</a>
        <a href="#connect-another-device">Devices</a>
        <a href="#core-instructions">Core instructions</a>
        <a href="/chief.md">Plain Markdown</a>
      </nav>
      <ChiefGuide />
    </div>
  );
}
