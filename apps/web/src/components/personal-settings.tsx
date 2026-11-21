"use client";

import { AppThemeChoice } from "@/components/app-theme";
import { TemplSupportButton } from "@/components/templ-support";

import styles from "./workspace/workspace-settings.module.css";

export function PersonalSettings() {
  return (
    <section id="appearance-help" className={styles.personal} aria-label="Appearance and help">
      <AppThemeChoice />
      <TemplSupportButton className="button secondary" label="Help and feedback">
        Help and feedback
      </TemplSupportButton>
    </section>
  );
}
