"use client";

import { preconnect } from "react-dom";
import { SITE } from "@/lib/site-environment";

/** Opens connections to the community service while the page loads, so the
 * first call skips DNS and TLS. The support widget fetches without cookies
 * and the app with them; browsers keep those on separate connections, so
 * each gets one. A hint only: it sends no request and carries no data. */
export function CommunityPreconnect() {
  // Credentialed first: React looks for an existing hint by href, and a
  // link without crossorigin would otherwise match the anonymous one.
  preconnect(SITE.community);
  preconnect(SITE.community, { crossOrigin: "anonymous" });
  return null;
}
