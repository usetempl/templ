import {
  readServingReleaseIdentity,
  type ServingReleaseIdentity,
} from "@templ/chat/support-install-fixture";
import { APP_ENVIRONMENT } from "./site-environment";

declare global {
  interface CloudflareEnv {
    RELEASE_IDENTITY?: string;
    CF_VERSION_METADATA?: { id?: string };
  }
}

/** The platform version is required. A manifest cannot supply it. */
export function webReleaseIdentity(bindings: {
  RELEASE_IDENTITY?: string;
  CF_VERSION_METADATA?: { id?: string };
}): ServingReleaseIdentity {
  const identity = JSON.parse(bindings.RELEASE_IDENTITY ?? "null");
  return readServingReleaseIdentity(
    {
      schemaVersion: identity?.schemaVersion,
      environment: identity?.environment,
      commit: identity?.commit,
      sourceDigest: identity?.sourceDigest,
      lockfileSha256: identity?.lockfileSha256,
      service: "web",
      versionId: bindings.CF_VERSION_METADATA?.id,
    },
    "web",
    APP_ENVIRONMENT,
  );
}
