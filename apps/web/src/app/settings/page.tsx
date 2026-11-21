import type { Metadata } from "next";
import Link from "next/link";
import { PersonalSettings } from "@/components/personal-settings";
import styles from "@/components/linked-wallets.module.css";
import { copy as t } from "@/lib/copy";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: t("shell.settings.title"),
    robots: { index: false, follow: false },
  };
}
export default async function SettingsPage() {
  return (
    <div className={styles.page}>
      <h1>{t("shell.settings.title")}</h1>
      <PersonalSettings />
      <ul className={styles.list}>
        <li className={styles.row}>
          <Link href="/settings/account">
            {t("shell.common.signInMethods")}
          </Link>
          <p className={styles.hint}>{t("shell.settings.signInMethodsHint")}</p>
        </li>
      </ul>
    </div>
  );
}
