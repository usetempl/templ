"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import {
  readAppTheme,
  serverAppTheme,
  setAppTheme,
  subscribeAppTheme,
} from "@/lib/app-theme";
import styles from "./app-theme.module.css";

export function AppTheme() {
  const pathname = usePathname();
  useEffect(() => subscribeAppTheme(() => {}), [pathname]);
  return null;
}

export function AppThemeChoice() {
  const choice = useSyncExternalStore(
    subscribeAppTheme,
    readAppTheme,
    serverAppTheme,
  );
  return (
    <fieldset className={styles.choice}>
      <legend>Appearance</legend>
      <div className={styles.options}>
        {(["system", "light", "dark"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={choice === value}
            onClick={() => setAppTheme(value)}
          >
            {value === "system"
              ? "System"
              : value === "light"
                ? "Light"
                : "Dark"}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
