#!/usr/bin/env node
// Fails a web build whose client files carry a private manifest value: a
// workspace UUID that a grant or the operator coverage names, or an approver
// login. The web build runs it on .next/static and public/; the deploy runs
// it again on .open-next/assets. It prints the kind and the file, never the
// value.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  manifestSecrets,
  readReleaseManifest,
} from "../../../web/scripts/release-public.mjs";

const root = resolve(import.meta.dirname, "../../../..");
const TEXT = /\.(?:m?js|cjs|css|html?|json|txt|map|svg|xml|webmanifest|md)$/i;
export const DEFAULT_MANIFESTS = [
  "v4-release.json",
  "v4-release-production.json",
];
export const DEFAULT_DIRECTORIES = [
  "apps/web/.next/static",
  "apps/web/.open-next/assets",
  "apps/web/public",
];

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && TEXT.test(entry.name)) yield path;
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Workspace ids inside the policy var texts. PRODUCT_GRANTS repeats every
 * grant's workspace, so a bundle that carries the var leaks the grant. */
function policyVarWorkspaceIds(manifest) {
  const publicWorkspaces = new Set([
    manifest?.templSupport?.workspaceId?.toLowerCase(),
    manifest?.exampleVault?.workspaceId?.toLowerCase(),
  ]);
  const vars = manifest?.policyVars;
  if (!vars || typeof vars !== "object") return [];
  return Object.values(vars)
    .filter((text) => typeof text === "string")
    .flatMap((text) => text.match(UUID) ?? [])
    .map((id) => id.toLowerCase())
    .filter((id) => !publicWorkspaces.has(id));
}

/** Every private value of every manifest, merged. */
export function collectSecrets(manifests) {
  const workspaceIds = new Set();
  const logins = new Set();
  for (const manifest of manifests) {
    const found = manifestSecrets(manifest);
    found.workspaceIds.forEach((id) => workspaceIds.add(id));
    policyVarWorkspaceIds(manifest).forEach((id) => workspaceIds.add(id));
    found.logins.forEach((login) => logins.add(login));
  }
  return { workspaceIds: [...workspaceIds], logins: [...logins] };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Findings as { file, kind }, one per file and kind. */
export function scanDirectories(directories, secrets) {
  const patterns = [
    ...secrets.workspaceIds.map((id) => ({
      kind: "grant workspace id",
      pattern: new RegExp(escape(id), "i"),
    })),
    ...secrets.logins.map((login) => ({
      kind: "approver login",
      pattern: new RegExp(
        `(?<![A-Za-z0-9-])${escape(login)}(?![A-Za-z0-9-])`,
        "i",
      ),
    })),
  ];
  const findings = [];
  if (!patterns.length) return findings;
  for (const directory of directories) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const file of files(directory)) {
      const text = readFileSync(file, "utf8");
      for (const kind of new Set(
        patterns.filter(({ pattern }) => pattern.test(text)).map((p) => p.kind),
      ))
        findings.push({ file, kind });
    }
  }
  return findings;
}

function main(argv) {
  if (!argv.includes("--forbid-manifest-secrets"))
    throw new Error(
      "Usage: scan-client-bundle.mjs --forbid-manifest-secrets [--dir <path>]... [--manifest <path>]...",
    );
  const option = (name) =>
    argv.flatMap((value, index) => (argv[index - 1] === name ? [value] : []));
  const manifests = (
    option("--manifest").length ? option("--manifest") : DEFAULT_MANIFESTS
  )
    .map((path) => resolve(root, path))
    .filter((path) => existsSync(path))
    .map((path) => readReleaseManifest(path));
  if (!manifests.length) throw new Error("No release manifest to read.");
  const directories = option("--dir").length
    ? option("--dir").map((path) => resolve(process.cwd(), path))
    : DEFAULT_DIRECTORIES.map((path) => resolve(root, path));
  const findings = scanDirectories(directories, collectSecrets(manifests));
  for (const { file, kind } of findings)
    console.error(
      `Client file carries a private manifest value (${kind}): ${relative(root, file)}`,
    );
  if (findings.length) process.exit(1);
  console.log("Client files carry no private manifest values.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
