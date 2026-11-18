"use client";

import { ANALYTICS_SOURCES, type AnalyticsEvent } from "./analytics-events";
import {
  onboardingAllowed,
  onboardingJourney,
  resetOnboardingJourney,
} from "./onboarding-session";
import { SITE } from "./site-environment";

type Pending = {
  journey: string;
  name: AnalyticsEvent;
  path: string;
  attempts: number;
};
const pending: Pending[] = [];
let sending = false;
let generation = 0;
let workspace: string | undefined;
export function analyticsWorkspace(id?: string) {
  workspace = id;
}
export function resetAnalyticsJourney() {
  generation++;
  pending.length = 0;
  resetOnboardingJourney();
}
async function drain() {
  if (sending) return;
  sending = true;
  const version = generation;
  try {
    while (pending.length && version === generation) {
      if (!onboardingAllowed()) {
        resetAnalyticsJourney();
        return;
      }
      const event = pending[0];
      try {
        const response = await fetch(`${SITE.community}${event.path}`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          keepalive: true,
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ journey: event.journey, name: event.name }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok && (response.status >= 500 || response.status === 429))
          throw new Error("retry");
        await response.body?.cancel();
        if (version === generation) pending.shift();
      } catch {
        if (version !== generation) return;
        if (++event.attempts >= 3) pending.shift();
        else
          await new Promise((resolve) =>
            setTimeout(resolve, event.attempts * 1500),
          );
      }
    }
  } finally {
    sending = false;
    if (pending.length) void drain();
  }
}
/** Fixed first-party events. Analytics never waits inside a product action. */
export function trackEvent(name: AnalyticsEvent) {
  try {
    if (!Object.hasOwn(ANALYTICS_SOURCES, name)) return;
    const journey = onboardingJourney();
    if (!journey) return;
    const match = /^\/inbox\/([0-9a-f-]+)(?:\/|$)/.exec(location.pathname);
    const id = match?.[1] ?? workspace;
    const path =
      id &&
      (ANALYTICS_SOURCES[name] === "workspace" ||
        ANALYTICS_SOURCES[name] === "billing")
        ? `/rooms/${id}/onboarding`
        : "/funnel/journey";
    if (
      pending.length < 128 &&
      !pending.some(
        (event) =>
          event.journey === journey &&
          event.name === name &&
          event.path === path,
      )
    )
      pending.push({ journey, name, path, attempts: 0 });
    void drain();
    if (name === "create_completed" || name === "connect_completed")
      resetOnboardingJourney();
  } catch {
    /* Measurement cannot change support, navigation or wallet actions. */
  }
}
