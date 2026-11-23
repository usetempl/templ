"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import {
  type AppTheme as AppThemePreference,
  readAppTheme,
  serverAppTheme,
  setAppTheme,
  subscribeAppTheme,
} from "@/lib/app-theme";
import styles from "./app-theme.module.css";

export function AppTheme() {
  const pathname = usePathname();
  useEffect(() => subscribeAppTheme(() => {}), [pathname]);
  useEffect(() => {
    const select = (event: Event) => {
      if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-templ-site-appearance")) return;
      const choice = (event as CustomEvent).detail;
      if (choice === "light" || choice === "dark") setAppTheme(choice);
    };
    document.addEventListener("templ:visitor-appearance", select);
    return () => document.removeEventListener("templ:visitor-appearance", select);
  }, []);
  return null;
}

export function AppThemeChoice() {
  const choice = useSyncExternalStore<AppThemePreference | null>(
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
            aria-pressed={(choice ?? "system") === value}
            disabled={choice === null}
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
