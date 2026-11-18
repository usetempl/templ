import Link from "next/link";
import { IconArrowLeft, IconLayoutGrid } from "@tabler/icons-react";
import { TemplMark } from "@/components/brand/templ-mark";
import { copy as t } from "@/lib/copy";
import styles from "./app-state.module.css";

/** The missing-page view gives the member a route back to the app. */
export default async function NotFound() {
  return (
    <section className={styles.surface} data-state="not-found">
      <TemplMark className={styles.lostStamp} decorative />
      <h1>{t("shell.notFound.title")}</h1>
      <p>{t("shell.notFound.hint")}</p>
      <div className={styles.actions}>
        <Link href="/" className="button">
          <IconArrowLeft aria-hidden="true" /> {t("shell.notFound.back")}
        </Link>
        <Link href="/inbox" className="button secondary">
          <IconLayoutGrid aria-hidden="true" /> Your workspaces
        </Link>
      </div>
    </section>
  );
}
