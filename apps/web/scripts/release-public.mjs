// The public part of a release manifest. next.config.ts inlines this
// projection as TEMPL_RELEASE_PUBLIC, so client bundles never carry the
// manifest itself: grants name workspaces, and approvals name people.
// An explicit allowlist: a field reaches the browser only when it is named
// here. Top-level flags pass when their name ends in Verified or Proved and
// their value is a boolean, so a new flag needs no change here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  paymentRecipients,
  readProductAssets,
} from "../../scripts/src/release/product-payment-config.mjs";

export function releaseManifestFor(
  environment = process.env.NEXT_PUBLIC_APP_ENV ?? "staging",
) {
  if (!["staging", "production"].includes(environment))
    throw new Error("NEXT_PUBLIC_APP_ENV must be staging or production.");
  if (environment === "production") throw new Error("This source snapshot does not include hosted release configuration.");
  return fileURLToPath(new URL("../../../v4-release.json", import.meta.url));
}
export const releaseManifestPath = releaseManifestFor();

/** Fields that never reach a client bundle, whatever their shape. */
export const PRIVATE_RELEASE_FIELDS = Object.freeze([
  "productGrants",
  "revokedProductGrants",
  "operatorCoverage",
  "approvers",
  "approvals",
  "legalApproval",
  "moneyTrialApproval",
  "manualBillingTrial",
  "stagingBasis",
  "hostedTrials",
  "webOnlyRetention",
  "policyVars",
  "operatorBlockers",
  "workspaceFlags",
  "productDeals",
  "revokedProductDeals",
]);

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
const FLAG = /^[a-z][A-Za-z0-9]*(Verified|Proved)$/;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
/** Named scalar fields of a block, plus every boolean when `booleans`. */
function pick(block, names, { booleans = false } = {}) {
  if (!isObject(block)) return undefined;
  const result = {};
  for (const [key, value] of Object.entries(block))
    if (
      (names.includes(key) && scalar(value)) ||
      (booleans && typeof value === "boolean")
    )
      result[key] = value;
  return result;
}
const booleans = (block) =>
  isObject(block)
    ? Object.fromEntries(
        Object.entries(block).filter(([, value]) => typeof value === "boolean"),
      )
    : undefined;

/** The browser-safe projection of `manifest`. */
export function projectRelease(manifest) {
  if (!isObject(manifest)) throw new Error("Release manifest");
  const result = {};
  for (const key of SCALARS) if (key in manifest) result[key] = manifest[key];
  result.blockers = Array.isArray(manifest.blockers)
    ? manifest.blockers.filter((line) => typeof line === "string")
    : [];
  for (const [key, value] of Object.entries(manifest))
    if (FLAG.test(key) && typeof value === "boolean") result[key] = value;
  const blocks = {
    solana: pick(manifest.solana, ["planBilling"], { booleans: true }),
    productOffer: pick(manifest.productOffer, ["version", "payment"], {
      booleans: true,
    }),
    // Templ's own workspace is public: its widget runs on Templ's site.
    templSupport: pick(manifest.templSupport, ["workspaceId", "expiresAt"], {
      booleans: true,
    }),
    exampleVault: pick(manifest.exampleVault, ["workspaceId"]),
    supportAlerts: booleans(manifest.supportAlerts),
    agentApi: pick(manifest.agentApi, ["version"]),
  };
  if (isObject(manifest.productOffer?.recipients))
    blocks.productOffer.recipients = Object.fromEntries(
      Object.entries(manifest.productOffer.recipients).filter(
        ([, value]) => value === null || typeof value === "string",
      ),
    );
  if (isObject(manifest.productOffer?.rails))
    blocks.productOffer.rails = booleans(manifest.productOffer.rails);
  if (isObject(manifest.supportDiagnosis))
    blocks.supportDiagnosis = {
      chains: Array.isArray(manifest.supportDiagnosis.chains)
        ? manifest.supportDiagnosis.chains.filter(scalar)
        : [],
    };
  for (const [key, value] of Object.entries(blocks))
    if (value !== undefined) result[key] = value;
  return result;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{1,37}[A-Za-z0-9])$/;
const PERSON_KEYS = ["login", "approver", "approvedBy", "reviewer", "by"];
// Production records name the approving role, not a person; a role is public.
const ROLES = new Set(["founder"]);
function strings(value, into = []) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (isObject(value))
    for (const item of Object.values(value)) strings(item, into);
  return into;
}
/** What a client bundle must never contain: every workspace UUID a grant or
 * the operator coverage names, and every approver login. Templ's own
 * workspace and the Example Vault workspace are public widget configuration. */
export function manifestSecrets(manifest) {
  const publicWorkspaces = new Set([
    manifest?.templSupport?.workspaceId?.toLowerCase(),
    manifest?.exampleVault?.workspaceId?.toLowerCase(),
  ]);
  const workspaceIds = new Set();
  for (const field of [
    "productGrants",
    "revokedProductGrants",
    "operatorCoverage",
    "workspaceFlags",
    "productDeals",
    "revokedProductDeals",
  ])
    for (const text of strings(manifest?.[field]))
      for (const id of text.match(UUID) ?? [])
        if (!publicWorkspaces.has(id.toLowerCase()))
          workspaceIds.add(id.toLowerCase());
  const logins = new Set();
  const addLogin = (text) => {
    if (
      typeof text === "string" &&
      LOGIN.test(text) &&
      !/^\d+$/.test(text) &&
      !ROLES.has(text)
    )
      logins.add(text);
  };
  // `approvers` lists logins; `approvals` and `legalApproval` name them under
  // a person key.
  for (const text of strings(manifest?.approvers)) addLogin(text);
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isObject(value))
      for (const [key, item] of Object.entries(value))
        if (PERSON_KEYS.includes(key)) strings(item).forEach(addLogin);
        else visit(item);
  };
  visit(manifest?.approvals);
  visit(manifest?.legalApproval);
  return { workspaceIds: [...workspaceIds], logins: [...logins] };
}

export function readReleaseManifest(path = releaseManifestFor()) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Production bundles carry closed defaults. Activation arrives with the request. */
export function buildRelease(manifest) {
  const release = projectRelease(manifest);
  if (release.environment !== "production") return release;
  for (const key of Object.keys(release))
    if (FLAG.test(key)) release[key] = false;
  release.blockers = [];
  release.solana = { signIn: false, planBilling: "unavailable" };
  release.templSupport = {
    workspaceId: null,
    verified: false,
    expiresAt: null,
  };
  release.agentApi = { version: null };
  release.supportDiagnosis = { chains: [] };
  if (release.supportAlerts)
    for (const key of Object.keys(release.supportAlerts))
      release.supportAlerts[key] = false;
  if (release.productOffer) {
    for (const key of Object.keys(release.productOffer))
      if (typeof release.productOffer[key] === "boolean")
        release.productOffer[key] = false;
    if (release.productOffer.rails)
      for (const key of Object.keys(release.productOffer.rails))
        release.productOffer.rails[key] = false;
  }
  return release;
}

/** Public values for static docs and blog builds. */
export function releasePublicEnv(manifest = readReleaseManifest()) {
  return {
    TEMPL_RELEASE_PUBLIC: JSON.stringify(projectRelease(manifest)),
    TEMPL_PAYMENT_RECIPIENTS: JSON.stringify(
      paymentRecipients(
        manifest,
        readProductAssets(
          readFileSync(
            new URL(
              "../../../packages/chat/src/product-payment-assets.ts",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    ),
  };
}

/** Web bundles keep availability closed until the request supplies activation. */
export function webBuildEnv(manifest = readReleaseManifest()) {
  const widgetManifest = JSON.parse(readFileSync(
    new URL("../src/lib/support-widget-versions.json", import.meta.url), "utf8",
  ));
  const widget = widgetManifest.versions.find(({ id }) => id === widgetManifest.latest);
  if (!widget) throw new Error("The current widget is missing from its manifest.");
  const framehost = widget.chunks.framehost;
  return {
    TEMPL_WIDGET_ASSETS: JSON.stringify({
      path: widget.path,
      sourceSha256: widget.sourceSha256,
      framehost: framehost ? { path: framehost.path, sha384: framehost.sha384 } : null,
    }),
    ...releasePublicEnv(manifest),
    TEMPL_RELEASE_PUBLIC: JSON.stringify(buildRelease(manifest)),
  };
}
