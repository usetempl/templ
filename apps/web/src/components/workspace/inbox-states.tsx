"use client";

import type { ReactNode } from "react";
import { copy as t, type MessageKey } from "@/lib/copy";
import { TemplMark } from "../brand/templ-mark";
import styles from "./workspace.module.css";

export function CaseListSkeleton({
  label = "shell.loading.cases",
}: {
  label?: MessageKey;
}) {
  return (
    <div
      className={styles.caseSkeleton}
      role="status"
      aria-label={t(label)}
      aria-busy="true"
    >
      <span className={styles.stateSrOnly}>{t(label)}</span>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className={styles.caseSkeletonRow} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

export function InboxEmptyState({
  message,
  action,
}: {
  message: MessageKey;
  action?: ReactNode;
}) {
  return (
    <div className={styles.inboxEmpty}>
      <TemplMark className={styles.emptyStamp} decorative />
      <p>{t(message)}</p>
      {action}
    </div>
  );
}
