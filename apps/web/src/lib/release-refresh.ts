import { releaseConfiguration, type ReleaseConfiguration } from "./release-configuration";

/** Recover only a server-validated projection for this page's serving version. */
export function refreshedReleaseConfiguration(
  value: unknown,
  expected: ReleaseConfiguration["web"],
): ReleaseConfiguration | null {
  if (!expected || !value || typeof value !== "object") return null;
  const next = value as ReleaseConfiguration;
  if (
    !next.web ||
    Object.keys(next.web).length !== Object.keys(expected).length ||
    !Object.entries(expected).every(
      ([key, entry]) => next.web?.[key as keyof typeof expected] === entry,
    ) ||
    next.release?.environment !== "production" ||
    next.unavailable === true ||
    (next.activationDigest !== null &&
      (typeof next.activationDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(next.activationDigest)))
  )
    return null;
  // A confirmed closed response can revoke features, never grant unpinned ones.
  return next.activationDigest === null
    ? releaseConfiguration(null, expected)
    : next;
}
