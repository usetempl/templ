"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackEvent, resetAnalyticsJourney } from "@/lib/analytics";
import { blogInstallEvent, type AnalyticsEvent } from "@/lib/analytics-events";
import {
  peekCommunitySession,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import { SITE } from "@/lib/site-environment";

const LANDING_CONVERSIONS = {
  create_clicked: { href: "/create", button: false },
  talk_to_us_clicked: { href: "", button: true },
  pilot_clicked: { href: "", button: true },
  pricing_rules_clicked: {
    href: `${SITE.docs}/pricing#planned-usage-pricing`,
    button: false,
  },
} as const satisfies Partial<
  Record<AnalyticsEvent, { href: string; button: boolean }>
>;

/** First-party measurement runs only in Templ's app, never in customer widgets. */
export function AnalyticsProvider() {
  const pathname = usePathname();
  const viewed = useRef(new Set<string>());
  useEffect(() => {
    let previous = peekCommunitySession()?.principalId;
    return subscribeCommunitySession(() => {
      const next = peekCommunitySession()?.principalId;
      if (previous && next !== previous) {
        resetAnalyticsJourney();
        viewed.current.clear();
      }
      previous = next;
    });
  }, []);
  useEffect(() => {
    if (viewed.current.has(pathname)) return;
    viewed.current.add(pathname);
    if (pathname === "/") {
      trackEvent("landing_view");
      const blog = blogInstallEvent(location.search);
      if (blog) trackEvent(blog);
    } else if (pathname === "/create") trackEvent("create_viewed");
    else if (/^\/connect\/[^/]+$/.test(pathname)) trackEvent("connect_opened");
  }, [pathname]);
  useEffect(() => {
    const clicked = (event: MouseEvent) => {
      if (pathname !== "/" || !(event.target instanceof Element)) return;
      const control = event.target.closest<HTMLElement>(
        "[data-templ-conversion]",
      );
      const name = control?.dataset.templConversion;
      if (!control || !name || !Object.hasOwn(LANDING_CONVERSIONS, name))
        return;
      const target =
        LANDING_CONVERSIONS[name as keyof typeof LANDING_CONVERSIONS];
      if (control instanceof HTMLButtonElement) {
        if (!target.button) return;
      } else {
        if (target.button || !(control instanceof HTMLAnchorElement)) return;
        const href = control.getAttribute("href") ?? "";
        if (
          href !== target.href &&
          !(name === "create_clicked" && href.startsWith(`${target.href}?`))
        )
          return;
      }
      trackEvent(name as keyof typeof LANDING_CONVERSIONS);
    };
    document.addEventListener("click", clicked);
    return () => document.removeEventListener("click", clicked);
  }, [pathname]);
  return null;
}
