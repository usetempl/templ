"use client";

import type { AnalyticsEvent } from "./analytics-events";
import { APP_ENVIRONMENT, SITE } from "./site-environment";

export function browserBlocksStatistics() {
  return (
    navigator.webdriver ||
    navigator.doNotTrack === "1" ||
    navigator.doNotTrack === "yes" ||
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl === true
  );
}

export const statisticsPreference = "templ-allow-site-statistics";

const pages: Partial<Record<AnalyticsEvent, string>> = {
  landing_view: "/",
  hosted_support_opened: "/chat",
  workspace_home_viewed: "/workspace",
};

export function trackEvent(name: AnalyticsEvent) {
  if (!Object.hasOwn(pages, name)) return;
  const page = pages[name];
  if (
    !page ||
    typeof window === "undefined" ||
    APP_ENVIRONMENT !== "production" ||
    window.self !== window.top ||
    location.origin !== "https://usetempl.com" ||
    location.origin !== SITE.origin ||
    browserBlocksStatistics()
  )
    return;
  try {
    if (
      localStorage.getItem(statisticsPreference) !== "yes" ||
      localStorage.getItem("plausible_ignore") === "true"
    )
      return;
    void fetch("https://plausible.io/api/event", {
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      keepalive: true,
      redirect: "error",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        name: "pageview",
        domain: "usetempl.com",
        url: SITE.origin + page,
      }),
    }).catch(() => {});
  } catch {
    return;
  }
}
