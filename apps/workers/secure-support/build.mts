/** Public profile input only; private keys and credentials are never build inputs. */
import {createRequire} from "node:module";
import {mkdir, readFile, writeFile, copyFile} from "node:fs/promises";
import {resolve, dirname} from "node:path";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {verifyEncryptionProfile} from "@templ/e2ee/verify";

const here = import.meta.dirname, root = resolve(here, "../../..");
const require = createRequire(import.meta.url);
const runtime = createRequire(require.resolve("wrangler/package.json"));
const {build} = runtime("esbuild");
const profilePath = process.argv.find(value => value.startsWith("--profile="))?.slice(10);
if (!profilePath) throw new Error("Build requires an explicit signed public Own profile.");
const config = JSON.parse(await readFile(resolve(profilePath), "utf8"));
const raw = config.profile ?? config;
const profile = await verifyEncryptionProfile(raw, raw.rootKey);
if (profile.custody !== "templ-own-support") throw new Error("Build requires the fixed Own support profile.");
const out = resolve(here, "dist");
await mkdir(out, {recursive: true});
const built = await build({
  entryPoints: [resolve(here, "client/index.ts")], outfile: resolve(out, "client.js"),
  bundle: true, format: "esm", target: "es2022", minify: true, metafile: true,
  write: false, loader: {".module.css": "local-css"},
  external: ["/geist.woff2", "/geist-mono.woff2"],
  define: {__OWN_ROOT_KEY__: JSON.stringify(profile.rootKey)},
});
const report: Record<string, {sha256: string; bytes: number; gzipBytes: number}> = {};
for (const file of built.outputFiles) {
  await mkdir(dirname(file.path), {recursive: true});
  await writeFile(file.path, file.contents);
  report[file.path.slice(out.length + 1)] = {sha256: createHash("sha256").update(file.contents).digest("hex"),
    bytes: file.contents.length, gzipBytes: gzipSync(file.contents).length};
}
const staticFiles = {
  "index.html": resolve(here, "client/index.html"),
  "templ-wordmark.svg": resolve(root, "apps/web/public/art/brand/templ-wordmark.svg"),
  "templ-square.svg": resolve(root, "apps/web/public/art/brand/templ-square.svg"),
  "geist.woff2": resolve(root, "apps/web/node_modules/next/dist/next-devtools/server/font/geist-latin.woff2"),
  "geist-mono.woff2": resolve(root, "apps/web/node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2"),
};
for (const [name, source] of Object.entries(staticFiles)) {
  await copyFile(source, resolve(out, name));
  const bytes = await readFile(source);
  report[name] = {sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, gzipBytes: gzipSync(bytes).length};
}
await writeFile(resolve(out, "asset-manifest.json"), JSON.stringify({v: 1, workspace: profile.workspace,
  rootKey: profile.rootKey, profileSignature: profile.signature, assets: report}, null, 2) + "\n");
await writeFile(resolve(out, "bundle-inputs.json"), JSON.stringify(built.metafile, null, 2) + "\n");
console.log(JSON.stringify({built: true, assets: report}));
