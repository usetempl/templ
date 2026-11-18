"use client";

import { IconReload } from "@tabler/icons-react";
import { TemplMark } from "@/components/brand/templ-mark";
import { copy as t } from "@/lib/copy";
import styles from "./app-state.module.css";

/** Figma Error Full (5156:296861): the Crump pose in greyscale on noise. */
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className={styles.surface} data-state="error">
      <TemplMark className={styles.errorStamp} decorative />
      <h1>{t("shell.error.title")}</h1>
      <p>{t("shell.error.hint")}</p>
      <div className={styles.actions}>
        <button className="button" onClick={reset}>
          <IconReload aria-hidden="true" /> {t("shell.common.tryAgain")}
        </button>
      </div>
    </section>
  );
}
