import { getRelease } from "@/lib/config";
import type { MetadataRoute } from "next";
import { APP_ENVIRONMENT, SITE } from "@/lib/release-public";
import {
  PUBLIC_PAGE_PATHS,
  searchIndexingEnabled,
} from "../../scripts/search-indexing.mjs";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const RELEASE = await getRelease();
  return searchIndexingEnabled(APP_ENVIRONMENT, RELEASE)
    ? PUBLIC_PAGE_PATHS.map((path) => ({ url: `${SITE.origin}${path}` }))
    : [];
}
