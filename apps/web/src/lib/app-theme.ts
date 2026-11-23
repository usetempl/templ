import { brandAsset } from "./brand-assets";
import { restoreSiteAppearanceScript, savedSiteAppearance, saveSiteAppearance } from "./site-appearance";

export type AppTheme = "system" | "light" | "dark";

export const APP_THEME_KEY = "templ:appearance";
const THEME_EVENT = "templ:appearance-change";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";

function validTheme(value: string | null): AppTheme {
  return value === "light" || value === "dark" ? value : "system";
}

export function readAppTheme(): AppTheme {
  const choice = document.documentElement.dataset.appearance;
  if (choice === "system" || choice === "light" || choice === "dark")
    return choice;
  try {
    return validTheme(window.localStorage.getItem(APP_THEME_KEY));
  } catch {
    return validTheme(document.documentElement.dataset.appearance ?? null);
  }
}

export function serverAppTheme(): null {
  return null;
}

function applyAppTheme(choice = readAppTheme()) {
  document.documentElement.dataset.appearance = choice;
  document.documentElement.dataset.theme =
    choice === "system"
        ? window.matchMedia(SYSTEM_QUERY).matches
          ? "dark"
          : "light"
        : choice;
  const icon = document.getElementById("templ-theme-icon");
  icon?.setAttribute(
    "href",
    document.documentElement.dataset.theme === "dark"
      ? brandAsset("/favicon-dark.svg")
      : brandAsset("/favicon.svg"),
  );
}

export function setAppTheme(choice: AppTheme) {
  document.documentElement.dataset.appearance = choice;
  saveSiteAppearance(choice);
  try {
    window.localStorage.setItem(APP_THEME_KEY, choice);
  } catch {
    // The choice still works when browser storage is unavailable.
  }
  applyAppTheme();
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function subscribeAppTheme(onChange: () => void) {
  const media = window.matchMedia(SYSTEM_QUERY);
  const changed = () => {
    applyAppTheme();
    onChange();
  };
  const stored = (event: StorageEvent) => {
    if (event.key === APP_THEME_KEY || event.key === null) {
      applyAppTheme(validTheme(event.newValue));
      onChange();
    }
  };
  const restore = () => {
    const choice = savedSiteAppearance();
    if (choice && choice !== readAppTheme()) {
      applyAppTheme(choice);
      onChange();
    }
  };
  applyAppTheme();
  restore();
  window.addEventListener("pageshow", restore);
  window.addEventListener(THEME_EVENT, changed);
  window.addEventListener("storage", stored);
  media.addEventListener("change", changed);
  return () => {
    window.removeEventListener("pageshow", restore);
    window.removeEventListener(THEME_EVENT, changed);
    window.removeEventListener("storage", stored);
    media.removeEventListener("change", changed);
  };
}

/** Set the saved appearance before the browser paints the page. */
export const APP_THEME_SCRIPT = `${restoreSiteAppearanceScript(APP_THEME_KEY)};(()=>{let t="system";try{t=localStorage.getItem("${APP_THEME_KEY}")||t}catch{}if(t!=="light"&&t!=="dark")t="system";const h=document.documentElement;h.dataset.appearance=t;h.dataset.theme=t==="system"?(matchMedia("${SYSTEM_QUERY}").matches?"dark":"light"):t;document.getElementById("templ-theme-icon")?.setAttribute("href",h.dataset.theme==="dark"?"${brandAsset("/favicon-dark.svg")}":"${brandAsset("/favicon.svg")}")})()`;
