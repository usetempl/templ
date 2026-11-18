import { APP_ENVIRONMENT, type AppEnvironment } from "./site-environment";
import { BUILD_RELEASE } from "./release-public";
import { capabilityVerified } from "./support-availability";

/** The landing reads each capability from this request's release flags. */
export function plannedCapabilities(release: object = BUILD_RELEASE) {
  return {
    typedContext: capabilityVerified("TYPED_CONTEXT_VERIFIED", release),
    secretGuard: capabilityVerified("SECRET_GUARD_VERIFIED", release),
    aiMode: capabilityVerified("AI_MODE_VERIFIED", release),
    askAi: capabilityVerified("ASK_AI_VERIFIED", release),
    followUps: capabilityVerified("FOLLOW_UPS_VERIFIED", release),
    evidence: capabilityVerified("EVIDENCE_CHECK_VERIFIED", release),
    diagnosis: capabilityVerified("TRANSACTION_CHECKS_VERIFIED", release),
    teamAlerts: capabilityVerified("TEAM_CHANNEL_ALERTS_VERIFIED", release),
    telegramAlerts: capabilityVerified("TELEGRAM_ALERTS_VERIFIED", release),
  };
}
export type LandingFeature = keyof ReturnType<typeof plannedCapabilities>;
export type LandingFeatures = Record<LandingFeature, boolean>;

// NEXT_PUBLIC_TEMPL_LANDING_PREVIEW turns on the local preview. Set it on
// the command line that starts the dev server:
// `NEXT_PUBLIC_TEMPL_LANDING_PREVIEW=final pnpm --filter web dev`. Never set
// it in a workflow, the makefile, a wrangler file or a tracked env or config
// file; a test fails if one of those names it.

export const LANDING_PREVIEW_BANNER = "Preview of the planned page. Not live.";

/** True only in `next dev` with the variable set to `final`, and never for
 * the production environment. Every `next build` inlines NODE_ENV as
 * "production" in the server and the client bundle, so no deployed build can
 * turn the preview on. That matters because the variable itself is inlined
 * only when it is set at build time: unset, the server bundle keeps a runtime
 * `process.env` read, and OpenNext copies every Worker variable and secret
 * into `process.env`. */
export function landingPreviewEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_TEMPL_LANDING_PREVIEW,
  mode: string | undefined = process.env.NODE_ENV,
  environment: AppEnvironment = APP_ENVIRONMENT,
): boolean {
  return (
    mode === "development" && environment !== "production" && value === "final"
  );
}

export const LANDING_PREVIEW = landingPreviewEnabled();

/** The local preview shows planned features. Public builds follow release flags. */
export function landingFeatures(
  preview: boolean = LANDING_PREVIEW,
  planned: LandingFeatures = plannedCapabilities(),
): LandingFeatures {
  const features = { ...planned };
  if (preview)
    for (const key of Object.keys(features) as LandingFeature[])
      features[key] = true;
  return features;
}
