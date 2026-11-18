import { immutableRelease } from "./release-immutable";
import {
  readReleaseAvailability,
  releaseActivationCanonical,
  type ReleaseAvailability,
  type ReleasePublicProjection,
} from "@templ/chat/release-activation";
import type { ServingReleaseIdentity } from "@templ/chat/support-install-fixture";
import { BUILD_RELEASE, type PublicRelease } from "./release-public";

export type ReleaseConfiguration = {
  release: PublicRelease;
  web: ServingReleaseIdentity | null;
  activationDigest: string | null;
  unavailable?: true;
};

function withClosedDefaults(
  activation: ReleasePublicProjection,
): PublicRelease {
  const closed = structuredClone(BUILD_RELEASE);
  const active = structuredClone(activation);
  const release: Record<string, unknown> = { ...closed, ...active };
  for (const name of [
    "solana",
    "productOffer",
    "templSupport",
    "exampleVault",
    "supportAlerts",
    "agentApi",
    "supportDiagnosis",
  ]) {
    const baseline = (closed as unknown as Record<string, unknown>)[name];
    const value = active[name];
    if (value && typeof value === "object" && !Array.isArray(value))
      release[name] = { ...(baseline as object), ...value };
  }
  if (active.productOffer) {
    const offer = active.productOffer as Record<string, unknown>;
    const result = release.productOffer as Record<string, unknown>;
    for (const name of ["rails", "recipients"])
      if (offer[name])
        result[name] = {
          ...(closed.productOffer?.[name as "rails" | "recipients"] as object),
          ...(offer[name] as object),
        };
  }
  return release as unknown as PublicRelease;
}

export function releaseConfiguration(
  value: unknown,
  web: ServingReleaseIdentity | null,
): ReleaseConfiguration {
  let availability: ReleaseAvailability;
  try {
    availability = readReleaseAvailability(value);
    if (
      !web ||
      !availability.active ||
      releaseActivationCanonical(availability.web) !==
        releaseActivationCanonical(web)
    )
      throw new Error("Unavailable release.");
  } catch {
    return immutableRelease({
      release: structuredClone(BUILD_RELEASE),
      web,
      activationDigest: null,
    });
  }
  return immutableRelease({
    release: withClosedDefaults(availability.publicRelease!),
    web,
    activationDigest: availability.activationDigest,
  });
}
