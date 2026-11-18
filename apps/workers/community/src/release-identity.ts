import { json, type Env } from "./common";

/** This projection comes only from the serving runtime's captured release identity. */
export function releaseSourceIdentity(env: Pick<Env, "RELEASE_IDENTITY">) {
  try {
    const identity = JSON.parse(env.RELEASE_IDENTITY ?? "null");
    if (
      !identity ||
      identity.schemaVersion !== 1 ||
      !["staging", "production"].includes(identity.environment) ||
      !/^[0-9a-f]{40}$/.test(identity.commit) ||
      !/^[0-9a-f]{64}$/.test(identity.sourceDigest) ||
      !/^[0-9a-f]{64}$/.test(identity.lockfileSha256)
    )
      return null;
    return {
      schemaVersion: 1,
      environment: identity.environment,
      commit: identity.commit,
      sourceDigest: identity.sourceDigest,
      lockfileSha256: identity.lockfileSha256,
    };
  } catch {
    return null;
  }
}

/** Source identity is generated from a clean build; version identity comes from Cloudflare. */
export function releaseIdentity(env: Env) {
  const identity = releaseSourceIdentity(env),
    versionId = env.CF_VERSION_METADATA?.id;
  if (
    !identity ||
    typeof versionId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(versionId)
  )
    return json({ error: "Release identity is unavailable." }, 503);
  return json({ ...identity, service: "community", versionId });
}

/** Financial reads expose no source supplied by the edge, request headers or body. */
export function nativeReleaseSourceHeaders(
  env: Pick<Env, "RELEASE_IDENTITY">,
): Record<string, string> {
  const identity = releaseSourceIdentity(env);
  return identity ? { "X-Templ-Native-Source": JSON.stringify(identity) } : {};
}
