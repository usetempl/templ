import {
  JOURNEY_ID,
  ONBOARDING_HEADER,
  ONBOARDING_POLICY,
} from "@templ/chat/onboarding";
import { APP_ENVIRONMENT } from "./site-environment";

const KEY = "__Host-templ-onboarding";
let current: { id: string; expiresAt: number } | undefined;
let hadCookie = false;
export function onboardingAllowed() {
  return (
    typeof window !== "undefined" &&
    APP_ENVIRONMENT === "production" &&
    location.protocol === "https:" &&
    location.hostname === "usetempl.com" &&
    navigator.doNotTrack !== "1" &&
    navigator.doNotTrack !== "yes" &&
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl !== true
  );
}
export function resetOnboardingJourney() {
  current = undefined;
  hadCookie = false;
  try {
    document.cookie = `${KEY}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
  } catch {
    /* Storage is optional. */
  }
}
/** Session cookie shares one random journey across the install prompt and Connect tabs. */
export function onboardingJourney() {
  try {
    if (!onboardingAllowed()) {
      resetOnboardingJourney();
      return undefined;
    }
    const value = document.cookie
      .split("; ")
      .find((item) => item.startsWith(`${KEY}=`))
      ?.slice(KEY.length + 1);
    const [id, expiry] = value?.split(".") ?? [];
    const expiresAt = Number(expiry);
    if (!value && hadCookie) current = undefined;
    if (
      id &&
      JOURNEY_ID.test(id) &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > Date.now() &&
      expiresAt <= Date.now() + ONBOARDING_POLICY.browserLifetimeMs
    ) {
      current = { id, expiresAt };
      hadCookie = true;
    }
    if (!current || current.expiresAt <= Date.now()) {
      current = {
        id: crypto.randomUUID(),
        expiresAt: Date.now() + ONBOARDING_POLICY.browserLifetimeMs,
      };
      try {
        document.cookie = `${KEY}=${current.id}.${current.expiresAt}; Path=/; Secure; SameSite=Lax`;
      } catch {
        /* Use memory. */
      }
      hadCookie = document.cookie.includes(`${KEY}=${current.id}.`);
    }
    return current.id;
  } catch {
    return undefined;
  }
}
export function onboardingHeaders(path: string): Record<string, string> {
  if (
    path !== "/rooms" && path !== "/onboarding/claim" &&
    !["/auth/verify", "/auth/solana/verify", "/auth/email/login/verify"].includes(path) &&
    !/^\/connect\/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}(?:\/(?:approve|deny))?$/.test(
      path,
    )
  )
    return {};
  const id = onboardingJourney();
  return id ? { [ONBOARDING_HEADER]: id } : {};
}
