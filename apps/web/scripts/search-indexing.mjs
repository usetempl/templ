export const PUBLIC_PAGE_PATHS = Object.freeze([
  "/",
  "/availability",
  "/trust",
  "/terms",
  "/privacy",
  "/dpa",
  "/safety",
]);

/** Search opens only for an approved production release. */
export function searchIndexingEnabled(environment, release) {
  return environment === "production"
    && release.productionReleaseEnabled === true
    && release.indexingEnabled === true;
}

const publicRoutes = PUBLIC_PAGE_PATHS.filter((path) => path !== "/")
  .map((path) => path.slice(1))
  .join("|");

// Workspace slugs and every other app path stay out of search.
export const PRIVATE_PAGE_PATTERN = `/:path((?!(?:${publicRoutes})$).+)`;

export function searchRobotsMetadata(environment, release) {
  return searchIndexingEnabled(environment, release)
    ? { index: true, follow: true }
    : { index: false, follow: false, nosnippet: true, noimageindex: true };
}
