import { sha256, toHex } from "viem";

export type ServingReleaseIdentity = {
  schemaVersion: 1;
  environment: "production" | "staging";
  commit: string;
  sourceDigest: string;
  lockfileSha256: string;
  service: "community" | "web";
  versionId: string;
};
export type InstallFixtureScope = {
  environment: "production";
  namespace: string;
  appOrigin: "https://usetempl.com";
  communityOrigin: "https://community.usetempl.com";
  worker: ServingReleaseIdentity;
  web: ServingReleaseIdentity;
} & (
  | { schemaVersion: 1; attempt?: never }
  | { schemaVersion: 2; attempt: string }
);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new Error("Invalid install fixture scope.");
  return value as Record<string, unknown>;
}
export function readServingReleaseIdentity(
  value: unknown,
  service: "community" | "web",
  environment: "production" | "staging" = "production",
): ServingReleaseIdentity {
  const row = object(value, [
    "schemaVersion",
    "environment",
    "commit",
    "sourceDigest",
    "lockfileSha256",
    "service",
    "versionId",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.environment !== environment ||
    row.service !== service ||
    typeof row.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(row.commit) ||
    typeof row.sourceDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.sourceDigest) ||
    typeof row.lockfileSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.lockfileSha256) ||
    typeof row.versionId !== "string" ||
    !UUID.test(row.versionId)
  )
    throw new Error("Invalid serving release identity.");
  return {
    schemaVersion: 1,
    environment,
    commit: row.commit,
    sourceDigest: row.sourceDigest,
    lockfileSha256: row.lockfileSha256,
    service,
    versionId: row.versionId,
  };
}
export function readInstallFixtureScope(value: unknown): InstallFixtureScope {
  const version =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (version !== 1 && version !== 2)
    throw new Error("Invalid install fixture scope.");
  const row = object(value, [
    "schemaVersion",
    "environment",
    "namespace",
    "appOrigin",
    "communityOrigin",
    "worker",
    "web",
    ...(version === 2 ? ["attempt"] : []),
  ]);
  if (
    row.environment !== "production" ||
    typeof row.namespace !== "string" ||
    !NAMESPACE.test(row.namespace) ||
    row.appOrigin !== "https://usetempl.com" ||
    row.communityOrigin !== "https://community.usetempl.com"
  )
    throw new Error("Invalid install fixture scope.");
  const scope = {
    environment: "production" as const,
    namespace: row.namespace,
    appOrigin: "https://usetempl.com" as const,
    communityOrigin: "https://community.usetempl.com" as const,
    worker: readServingReleaseIdentity(row.worker, "community"),
    web: readServingReleaseIdentity(row.web, "web"),
  };
  if (version === 1) return { schemaVersion: 1, ...scope };
  if (typeof row.attempt !== "string" || !NAMESPACE.test(row.attempt))
    throw new Error("Invalid install fixture scope.");
  return { schemaVersion: 2, ...scope, attempt: row.attempt };
}
/** Each fixture is bound to its serving pair, Demo namespace and wire format. */
export function installFixtureWorkspace(value: InstallFixtureScope): string {
  const scope = readInstallFixtureScope(value);
  const digest = sha256(
    toHex(
      JSON.stringify([`templ-install-fixture-v${scope.schemaVersion}`, scope]),
    ),
  ).slice(2);
  const hex =
    scope.namespace.replace(/-/g, "").slice(0, 12) + digest.slice(0, 20);
  const uuid =
    hex.slice(0, 12) +
    "7" +
    hex.slice(13, 16) +
    (8 | (parseInt(hex[16], 16) & 3)).toString(16) +
    hex.slice(17);
  const workspace = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
  if (workspace === scope.namespace)
    throw new Error(
      "The install fixture cannot use the public Demo workspace.",
    );
  return workspace;
}
