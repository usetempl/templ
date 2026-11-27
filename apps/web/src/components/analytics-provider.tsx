"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackEvent } from "@/lib/analytics";
import { clearLegacyOnboardingCookie } from "@/lib/onboarding-session";

export function AnalyticsProvider() {
  const path = usePathname();
  const counted = useRef(false);
  useEffect(clearLegacyOnboardingCookie, []);
  useEffect(() => {
    if (path === "/" && !counted.current) trackEvent("landing_view");
    counted.current = path === "/";
  }, [path]);
  return null;
}
