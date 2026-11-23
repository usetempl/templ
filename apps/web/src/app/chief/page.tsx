import type { Metadata } from "next";
import { ChiefGuide } from "./guide";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Chief setup guide",
  description:
    "Set up Chief in Codex or Claude Code. Chief tracks tasks and relays results or questions. Your project lead makes decisions, tests the work and ships within your authorization.",
  alternates: { canonical: "/chief" },
};

export default function ChiefPage() {
  return (
    <div className={styles.page}>
      <nav className={styles.contents} aria-label="Chief guide">
        <span>Chief setup</span>
        <a href="#start-your-own-chief">Install</a>
        <a href="#working-rules">Chief and project leads</a>
        <a href="#lead-chats-in-codex">Lead chats</a>
        <a href="#use-dot-or-mobile">Dot / mobile</a>
        <a href="#connect-another-device">Devices</a>
        <a href="#core-instructions">Core instructions</a>
        <a href="#workspace-instructions">Workspace instructions</a>
        <a href="#private-relays">Private relays</a>
        <a href="#reach-a-claude-lead-from-codex">Claude relays</a>
        <a href="/chief.md">Plain Markdown</a>
      </nav>
      <ChiefGuide />
    </div>
  );
}
