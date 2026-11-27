export function clearLegacyOnboardingCookie() {
  try {
    document.cookie = "__Host-templ-onboarding=; Path=/; Secure; SameSite=Lax; Max-Age=0";
  } catch { /* Storage can be blocked. */ }
}
