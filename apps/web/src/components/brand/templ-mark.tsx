"use client";

import Image from "next/image";
import { brandAsset } from "@/lib/brand-assets";
import { useSyncExternalStore } from "react";
import styles from "./templ-brand.module.css";

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function readTheme() {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "auto";
}

function serverTheme() {
  return "auto";
}

export function TemplMark({
  className,
  decorative = false,
  label = "Templ",
  priority = false,
}: {
  className?: string;
  decorative?: boolean;
  label?: string;
  priority?: boolean;
}) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
  const darkMedia =
    theme === "dark"
      ? "all"
      : theme === "light"
        ? "not all"
        : "(prefers-color-scheme: dark)";
  const source = brandAsset("/art/brand/templ-square.svg");
  return (
    <span
      className={[styles.mark, className].filter(Boolean).join(" ")}
      data-brand-mark="square"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
    >
      {priority && (
        <link rel="preload" as="image" href={source} fetchPriority="high" />
      )}
      <picture>
        <source media={darkMedia} srcSet={source} />
        <Image
          src={source}
          alt=""
          width={1024}
          height={1024}
          unoptimized
          loading={priority ? "eager" : undefined}
          fetchPriority={priority ? "high" : undefined}
        />
      </picture>
    </span>
  );
}

export function TemplLogo({
  className,
  lockup = false,
}: {
  className?: string;
  lockup?: boolean;
}) {
  const asset = lockup ? "lockup" : "wordmark";
  return (
    <span className={[styles.wordmark, className].filter(Boolean).join(" ")}>
      <Image
        src={brandAsset(`/art/brand/${asset}-for-light.svg`)}
        alt="Templ"
        loading="eager"
        width={282}
        height={92}
        unoptimized
        className={styles.light}
      />
      <Image
        src={brandAsset(`/art/brand/${asset}-for-dark.svg`)}
        alt="Templ"
        loading="eager"
        width={282}
        height={92}
        unoptimized
        className={styles.dark}
      />
    </span>
  );
}
