import { getRelease } from "@/lib/config";
import type { MetadataRoute } from "next";
import { APP_ENVIRONMENT, SITE } from "@/lib/release-public";
import { searchIndexingEnabled } from "../../scripts/search-indexing.mjs";
export default async function robots(): Promise<MetadataRoute.Robots> {
  const RELEASE = await getRelease();
  return {
    rules: { userAgent: "*", allow: "/" },
    ...(searchIndexingEnabled(APP_ENVIRONMENT, RELEASE)
      ? { sitemap: `${SITE.origin}/sitemap.xml` }
      : {}),
  };
}
