"use client";

import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { IconMoon, IconSun } from "@tabler/icons-react";
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
  // A route can have its own default, so the theme is set before the new page paints.
  useLayoutEffect(() => subscribeAppTheme(() => {}), [pathname]);
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

const shownDark = () => document.documentElement.dataset.theme === "dark";
const serverDark = () => false;

/** One button for a page without room for the three choices. */
export function AppThemeSwitch() {
  const dark = useSyncExternalStore(subscribeAppTheme, shownDark, serverDark);
  return (
    <button
      type="button"
      className="button quiet icon"
      aria-label="Dark mode"
      aria-pressed={dark}
      onClick={() => setAppTheme(shownDark() ? "light" : "dark")}
    >
      {dark ? <IconMoon aria-hidden="true" /> : <IconSun aria-hidden="true" />}
    </button>
  );
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
