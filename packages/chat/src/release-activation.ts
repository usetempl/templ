import {
  readServingReleaseIdentity,
  type ServingReleaseIdentity,
} from "./support-install-fixture";
import { WORKSPACE_FEATURES, WORKSPACE_FLAG_KEYS } from "./workspace-flags";
import { PRODUCT_RAIL_IDS } from "./product-payment";

export const RELEASE_ACTIVATION_PATH = "/release/activation";
export const RELEASE_AVAILABILITY_PATH = "/release/availability";
export const RELEASE_ACTIVATION_SIGNING_SCOPE = "templ-release-activation-v1\n";
export const RELEASE_ACTIVATION_WINDOW_MS = 5 * 60_000;
export const RELEASE_ACTIVATION_MAX_BYTES = 32_768;
export type ReleasePublicProjection = Record<string, unknown>;
export type ReleaseActivation = {
  schemaVersion: 1;
  environment: "production";
  appOrigin: "https://usetempl.com";
  communityOrigin: "https://community.usetempl.com";
  worker: ServingReleaseIdentity;
  web: ServingReleaseIdentity;
  artifacts: {
    workerArtifactSha256: string;
    webArtifactSha256: string;
    workerArtifactDigest: string;
    webArtifactDigest: string;
    workerModuleSha256: string;
    workerAssetSha256: string;
    webModuleSha256: string;
    webAssetSha256: string;
    widgetAssetSha256: string;
  };
  mainCommit: string;
  mainCiRunId: string | null;
  evidenceIndexSha256: string;
  projectionSha256: string;
  publicRelease: ReleasePublicProjection;
  releasedFeatures: string[];
  previousDigest: string | null;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};
export type ReleaseAvailability = {
  schemaVersion: 1;
  environment: "production";
  active: boolean;
  activationDigest: string | null;
  publicRelease: ReleasePublicProjection | null;
  releasedFeatures: string[];
  worker: ServingReleaseIdentity | null;
  web: ServingReleaseIdentity | null;
};
export type ReleaseActivationMetadata = {
  schemaVersion: 1;
  environment: "production";
  activationDigest: string | null;
};
const HASH = /^[0-9a-f]{64}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FLAG = /^[a-z][A-Za-z0-9]*(Verified|Proved)$/;
const SCALARS = [
  "version",
  "environment",
  "chainId",
  "chainName",
  "productionReleaseEnabled",
  "indexingEnabled",
  "mode",
  "protocolRecipient",
];
const BLOCKS = [
  "blockers",
  "solana",
  "productOffer",
  "templSupport",
  "exampleVault",
  "supportAlerts",
  "agentApi",
  "supportDiagnosis",
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid release activation.");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(","))
    throw new Error("Invalid release activation fields.");
  return row;
}
function allowed(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).some((key) => !keys.includes(key)))
    throw new Error("Invalid public release fields.");
  return row;
}
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function bools(value: unknown, keys: readonly string[]) {
  const row = allowed(value, keys);
  if (Object.values(row).some((entry) => typeof entry !== "boolean"))
    throw new Error("Invalid public release flags.");
  return row;
}
/** Matches the browser projection and refuses private manifest fields. */
export function readReleasePublicProjection(
  value: unknown,
): ReleasePublicProjection {
  const row = object(value);
  for (const [key, entry] of Object.entries(row)) {
    if (FLAG.test(key)) {
      if (typeof entry !== "boolean")
        throw new Error("Invalid public release flag.");
    } else if (!SCALARS.includes(key) && !BLOCKS.includes(key))
      throw new Error("Invalid public release field.");
  }
  if (row.environment !== "production" || row.productionReleaseEnabled !== true)
    throw new Error("Invalid public release environment.");
  for (const key of SCALARS) {
    const entry = row[key];
    if (
      entry !== undefined &&
      entry !== null &&
      typeof entry !== "boolean" &&
      !(typeof entry === "number" && Number.isSafeInteger(entry)) &&
      !text(entry)
    )
      throw new Error("Invalid public release scalar.");
  }
  if (
    row.indexingEnabled !== undefined &&
    typeof row.indexingEnabled !== "boolean"
  )
    throw new Error("Invalid indexing flag.");
  if (
    row.blockers !== undefined &&
    (!Array.isArray(row.blockers) ||
      row.blockers.length > 100 ||
      row.blockers.some((entry) => !text(entry, 512)))
  )
    throw new Error("Invalid public blockers.");
  if (row.solana !== undefined) {
    const block = allowed(row.solana, ["signIn", "planBilling"]);
    if (
      (block.signIn !== undefined && typeof block.signIn !== "boolean") ||
      (block.planBilling !== undefined && !text(block.planBilling))
    )
      throw new Error("Invalid Solana projection.");
  }
  if (row.productOffer !== undefined) {
    const block = allowed(row.productOffer, [
      "version",
      "payment",
      "checkoutVerified",
      "cardBillingVerified",
      "rails",
      "recipients",
    ]);
    for (const [key, entry] of Object.entries(block)) {
      if (
        ["checkoutVerified", "cardBillingVerified"].includes(key) &&
        typeof entry !== "boolean"
      )
        throw new Error("Invalid offer flag.");
      if (["version", "payment"].includes(key) && !text(entry))
        throw new Error("Invalid offer field.");
    }
    if (block.rails !== undefined) bools(block.rails, PRODUCT_RAIL_IDS);
    if (block.recipients !== undefined) {
      const recipients = allowed(block.recipients, PRODUCT_RAIL_IDS);
      if (
        Object.values(recipients).some(
          (entry) => entry !== null && !text(entry, 128),
        )
      )
        throw new Error("Invalid public recipient.");
    }
  }
  if (row.templSupport !== undefined) {
    const block = allowed(row.templSupport, [
      "workspaceId",
      "expiresAt",
      "verified",
    ]);
    if (
      (block.workspaceId !== null &&
        block.workspaceId !== undefined &&
        !(
          typeof block.workspaceId === "string" &&
          UUID_V7.test(block.workspaceId)
        )) ||
      (block.expiresAt !== null &&
        block.expiresAt !== undefined &&
        !(
          text(block.expiresAt) && Number.isFinite(Date.parse(block.expiresAt))
        )) ||
      (block.verified !== undefined && typeof block.verified !== "boolean")
    )
      throw new Error("Invalid own-support projection.");
  }
  if (row.exampleVault !== undefined) {
    const block = exact(row.exampleVault, ["workspaceId"]);
    if (
      !(
        typeof block.workspaceId === "string" && UUID_V7.test(block.workspaceId)
      )
    )
      throw new Error("Invalid Demo projection.");
  }
  if (row.supportAlerts !== undefined)
    bools(row.supportAlerts, ["webhook", "slack", "discord", "telegram"]);
  if (row.agentApi !== undefined) {
    const block = exact(row.agentApi, ["version"]);
    if (block.version !== null && !text(block.version))
      throw new Error("Invalid agent projection.");
  }
  if (row.supportDiagnosis !== undefined) {
    const block = exact(row.supportDiagnosis, ["chains"]);
    if (
      !Array.isArray(block.chains) ||
      block.chains.length > 100 ||
      block.chains.some(
        (entry) =>
          entry !== "solana" &&
          !(
            (typeof entry === "number" &&
              Number.isSafeInteger(entry) &&
              entry > 0) ||
            (typeof entry === "string" &&
              /^[1-9]\d{0,15}$/.test(entry) &&
              Number.isSafeInteger(Number(entry)))
          ),
      ) ||
      new Set(block.chains.map(String)).size !== block.chains.length
    )
      throw new Error("Invalid diagnosis projection.");
  }
  return row;
}
export function projectedReleasedFeatures(
  value: ReleasePublicProjection,
): string[] {
  const released = (path: string) =>
    path
      .split(".")
      .reduce<unknown>(
        (entry, key) =>
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)[key]
            : undefined,
        value,
      ) === true;
  return WORKSPACE_FLAG_KEYS.filter((key) => {
    const feature = WORKSPACE_FEATURES[key];
    if ("workspaceOnly" in feature && feature.workspaceOnly) return false;
    return [
      feature.releaseFlag,
      ...("releaseRequires" in feature ? feature.releaseRequires : []),
    ].every(released);
  }).sort();
}
/** Canonical UTF-8 bytes are signed with the fixed scope prefix. */
export function releaseActivationCanonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(releaseActivationCanonical).join(",")}]`;
  return `{${Object.entries(object(value))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${releaseActivationCanonical(entry)}`,
    )
    .join(",")}}`;
}
export function readReleaseActivation(value: unknown): ReleaseActivation {
  const row = exact(value, [
    "schemaVersion",
    "environment",
    "appOrigin",
    "communityOrigin",
    "worker",
    "web",
    "artifacts",
    "mainCommit",
    "mainCiRunId",
    "evidenceIndexSha256",
    "projectionSha256",
    "publicRelease",
    "releasedFeatures",
    "previousDigest",
    "issuedAt",
    "expiresAt",
    "nonce",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.environment !== "production" ||
    row.appOrigin !== "https://usetempl.com" ||
    row.communityOrigin !== "https://community.usetempl.com" ||
    typeof row.mainCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(row.mainCommit) ||
    (row.mainCiRunId !== null &&
      (typeof row.mainCiRunId !== "string" ||
        !/^[1-9]\d{0,19}$/.test(row.mainCiRunId))) ||
    ![row.evidenceIndexSha256, row.projectionSha256, row.nonce].every(
      (entry) => typeof entry === "string" && HASH.test(entry),
    ) ||
    (row.previousDigest !== null &&
      !(
        typeof row.previousDigest === "string" && HASH.test(row.previousDigest)
      )) ||
    !Number.isSafeInteger(row.issuedAt) ||
    !Number.isSafeInteger(row.expiresAt) ||
    Number(row.issuedAt) < 0 ||
    Number(row.expiresAt) <= Number(row.issuedAt) ||
    Number(row.expiresAt) - Number(row.issuedAt) > RELEASE_ACTIVATION_WINDOW_MS
  )
    throw new Error("Invalid release activation metadata.");
  const artifacts = exact(row.artifacts, [
    "workerArtifactSha256",
    "webArtifactSha256",
    "workerArtifactDigest",
    "webArtifactDigest",
    "workerModuleSha256",
    "workerAssetSha256",
    "webModuleSha256",
    "webAssetSha256",
    "widgetAssetSha256",
  ]);
  if (
    Object.values(artifacts).some(
      (entry) => typeof entry !== "string" || !HASH.test(entry),
    )
  )
    throw new Error("Invalid release artifact digest.");
  const publicRelease = readReleasePublicProjection(row.publicRelease);
  const releasedFeatures = projectedReleasedFeatures(publicRelease);
  if (
    !Array.isArray(row.releasedFeatures) ||
    JSON.stringify(row.releasedFeatures) !== JSON.stringify(releasedFeatures)
  )
    throw new Error("Invalid released feature projection.");
  const activation = {
    ...row,
    worker: readServingReleaseIdentity(row.worker, "community"),
    web: readServingReleaseIdentity(row.web, "web"),
    artifacts,
    publicRelease,
    releasedFeatures,
  } as ReleaseActivation;
  if (
    releaseActivationCanonical(activation).length > RELEASE_ACTIVATION_MAX_BYTES
  )
    throw new Error("Release activation is too large.");
  return activation;
}
export function inactiveReleaseAvailability(): ReleaseAvailability {
  return {
    schemaVersion: 1,
    environment: "production",
    active: false,
    activationDigest: null,
    publicRelease: null,
    releasedFeatures: [],
    worker: null,
    web: null,
  };
}
export function readReleaseAvailability(value: unknown): ReleaseAvailability {
  const row = exact(value, [
    "schemaVersion",
    "environment",
    "active",
    "activationDigest",
    "publicRelease",
    "releasedFeatures",
    "worker",
    "web",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.environment !== "production" ||
    typeof row.active !== "boolean"
  )
    throw new Error("Invalid release availability.");
  if (!row.active) {
    if (
      releaseActivationCanonical(row) !==
      releaseActivationCanonical(inactiveReleaseAvailability())
    )
      throw new Error("Invalid inactive release availability.");
    return inactiveReleaseAvailability();
  }
  const publicRelease = readReleasePublicProjection(row.publicRelease);
  const releasedFeatures = projectedReleasedFeatures(publicRelease);
  if (
    typeof row.activationDigest !== "string" ||
    !HASH.test(row.activationDigest) ||
    releaseActivationCanonical(row.releasedFeatures) !==
      releaseActivationCanonical(releasedFeatures)
  )
    throw new Error("Invalid active release availability.");
  return {
    schemaVersion: 1,
    environment: "production",
    active: true,
    activationDigest: row.activationDigest,
    publicRelease,
    releasedFeatures,
    worker: readServingReleaseIdentity(row.worker, "community"),
    web: readServingReleaseIdentity(row.web, "web"),
  };
}
export function readReleaseActivationMetadata(
  value: unknown,
): ReleaseActivationMetadata {
  const row = exact(value, [
    "schemaVersion",
    "environment",
    "activationDigest",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.environment !== "production" ||
    (row.activationDigest !== null &&
      !(
        typeof row.activationDigest === "string" &&
        HASH.test(row.activationDigest)
      ))
  )
    throw new Error("Invalid release activation metadata.");
  return {
    schemaVersion: 1,
    environment: "production",
    activationDigest: row.activationDigest as string | null,
  };
}
