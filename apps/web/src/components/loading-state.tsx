"use client";

import type { CSSProperties, ReactNode } from "react";
import { copy as t } from "@/lib/copy";
import styles from "./loading-state.module.css";

/** Decorative shapes never stand in for verified balances or private content. */
export function Skeleton({
  width = "100%",
  height = "1em",
  round = false,
}: {
  width?: string;
  height?: string;
  round?: boolean;
}) {
  return (
    <span
      className={styles.shape}
      aria-hidden="true"
      data-round={round || undefined}
      style={
        { "--shape-width": width, "--shape-height": height } as CSSProperties
      }
    />
  );
}

function LoadingRegion({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={className}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <span className={styles.srOnly}>{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

export function LoadingSpinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

export function ChatSkeleton({
  header = false,
  composer = true,
  label = t("shell.loading.chat"),
}: {
  header?: boolean;
  composer?: boolean;
  label?: string;
}) {
  return (
    <LoadingRegion
      label={label}
      className={`${styles.chat} ${header ? styles.fullChat : ""}`}
    >
      {header && (
        <div className={styles.chatHeader}>
          <Skeleton width="42px" height="42px" round />
          <div className={styles.identity}>
            <Skeleton width="min(180px, 45vw)" height="18px" />
            <Skeleton width="110px" height="10px" />
          </div>
        </div>
      )}
      <div className={styles.chatBody}>
        <div className={styles.chatLines}>
          <Skeleton width="34%" height="10px" />
          <Skeleton width="72%" height="14px" />
          <Skeleton width="58%" height="14px" />
        </div>
        <div className={styles.chatLines}>
          <Skeleton width="26%" height="10px" />
          <Skeleton width="62%" height="14px" />
          <Skeleton width="46%" height="14px" />
        </div>
        <div className={styles.chatLines}>
          <Skeleton width="30%" height="10px" />
          <Skeleton width="80%" height="14px" />
        </div>
      </div>
      {/* Same box as the real composer (field plus help line),
          so a room or channel switch does not move the composer. */}
      {composer && (
        <div className={styles.composer} data-reserves="composer">
          <Skeleton height="60px" />
          <span className={styles.composerHelp}>
            <Skeleton width="46%" height="10px" />
          </span>
        </div>
      )}
    </LoadingRegion>
  );
}
