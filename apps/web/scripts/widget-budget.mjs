import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

/** Founder budget: 40 KB raw and 14 KB gzip, decimal bytes, for
 * the file every protocol site loads. Every release reports the measured
 * size. The build, its test, the hosted verifier and the widget gate all
 * read this one value. */
export const WIDGET_BUDGET = Object.freeze({
  rawBytes: 40_000,
  gzipBytes: 14_000,
});
/** Each chunk the file loads on first use: the context card, the extras, and each wallet family's
 * sign-in. */
export const WIDGET_CHUNK_BUDGET = Object.freeze({
  rawBytes: 8_000,
  gzipBytes: 3_500,
});
/** The chunks every new build loads, in build order: `card` (the context
 * card), `context` (the typed details from the app, which loads the card),
 * `member` (the member lines under a thread), `extras` (what the chat shows
 * after a send, which loads the member lines), `evm` (sign-in with an
 * EIP-1193 wallet), `solana` (sign-in with a Solana wallet), `turnstile`
 * (the visitor check's frame) and `live` (the session after a reload,
 * remembered sign-in, the member socket and the check's loader). A page
 * loads only the wallet chunk for the wallet it passed, and none without
 * one; `live` for a returning guest, a page with a wallet or an open chat;
 * `turnstile` only for a new guest of a workspace with the check on.
 * `media` (a member's screenshot, from the Add screenshot button) and
 * `domain` (the verified-domain line) load only when the workspace's
 * policy has them. `frame`, `framebridge` and `framehost` are frame
 * mode's: the adapter Templ's frame document runs, the page's side of the
 * frame's wallet calls, and the file a protocol page loads in place of the
 * widget (which loads the bridge on the frame's first wallet call). */
export const WIDGET_CHUNKS = Object.freeze([
  "appearance",
  "drafts",
  "style",
  "lead",
  "card",
  // The typed details and the member lines.
  // Typed app parsing and labels, shared by live rows and failure snapshots.
  "details",
  "appParser",
  "diagnostics",
  "context",
  // Frozen failure rows; loads the typed context card when first needed.
  "snapshot",
  // Built before the member lines, which load it.
  "media",
  "member",
  // The install check, then the key warning and outcome consent, which
  // load it; the consent chunk loads them.
  "check",
  "ops",
  // The summary before a send, the empty chat's two questions, links in
  // messages and the lines that say a person from the team joined.
  "consent",
  // Sign-in, first-open controls and identity text.
  "conversation",
  "welcome",
  // Optional guest reply notices and one-use thread resume links.
  "guest",
  "art",
  "extras",
  "evm",
  "solana",
  // The visitor check and support-widget-live.ts.
  "turnstile",
  "encrypted",
  "live",
  // The verified-domain line and frame mode.
  "domain",
  "frame",
  "framebridge",
  "framehost",
]);

/** Raw bytes and gzip level 9 bytes of a built widget file. */
export function measureWidget(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    bytes: buffer.length,
    gzipBytes: gzipSync(buffer, { level: 9 }).length,
  };
}

/** Throws when a measured file is over its budget. */
export function assertWidgetBudget(
  size,
  budget = WIDGET_BUDGET,
  name = "support-widget.js",
) {
  if (size.bytes > budget.rawBytes || size.gzipBytes > budget.gzipBytes)
    throw new Error(
      `${name} is ${size.bytes} B (${size.gzipBytes} B gzip); the budget is ${budget.rawBytes} B (${budget.gzipBytes} B gzip).`,
    );
}

/** Days a replaced build that a release shipped keeps working. */
export const WIDGET_SUPPORT_DAYS = 90;

/** `date` (YYYY-MM-DD, UTC) plus `days`. */
export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The file names in `public/support-widget/` a build uses: its own copy and
 * each chunk it loads (older builds load only `card` and `extras`). */
export function widgetFiles(version) {
  return [
    `${version.id}.js`,
    ...Object.values(version.chunks ?? {}).map((chunk) =>
      chunk.path.split("/").pop(),
    ),
  ];
}

/** Files that no remaining build uses. */
function unused(removed, kept) {
  const keep = new Set(kept.flatMap(widgetFiles));
  return [
    ...new Set(removed.flatMap(widgetFiles).filter((name) => !keep.has(name))),
  ];
}

/** The manifest after `build` becomes the latest. A build no release shipped
 * (`publishedAt: null`) is replaced in place; a shipped one is superseded
 * today and kept for the support window. Returns the new manifest and the
 * file names to delete. */
export function addWidgetBuild(manifest, build, today) {
  const versions = manifest.versions.map((version) => ({ ...version }));
  const previous = versions.find((version) => version.id === manifest.latest);
  if (previous?.id === build.id) {
    if (
      Object.entries(build).every(
        ([key, value]) =>
          JSON.stringify(previous[key]) === JSON.stringify(value),
      )
    )
      return { manifest, remove: [] };
    if (previous.publishedAt !== null)
      throw new Error("A published widget build cannot change its artifacts.");
    const next = versions.map((version) =>
      version.id === build.id ? { ...version, ...build } : version,
    );
    return {
      manifest: { ...manifest, versions: next },
      remove: unused([previous], next),
    };
  }
  let kept = versions;
  if (previous?.publishedAt === null)
    kept = versions.filter((version) => version !== previous);
  else if (previous) {
    previous.supersededAt = today;
    previous.supportedUntil = addDays(today, WIDGET_SUPPORT_DAYS);
  }
  const next = [
    ...kept,
    { ...build, publishedAt: null, supersededAt: null, supportedUntil: null },
  ];
  return {
    manifest: { ...manifest, latest: build.id, versions: next },
    remove: unused(
      versions.filter((version) => !kept.includes(version)),
      next,
    ),
  };
}

/** Drops builds whose support ended before `today`. */
export function pruneWidgetBuilds(manifest, today) {
  const ended = (version) =>
    version.supportedUntil !== null && version.supportedUntil < today;
  const kept = manifest.versions.filter((version) => !ended(version));
  return {
    manifest: { ...manifest, versions: kept },
    remove: unused(manifest.versions.filter(ended), kept),
  };
}

/** The first broken manifest rule, or null. `files` maps each file name in
 * `public/support-widget/` to its SHA-256. */
export function widgetManifestProblem(manifest, files) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.supportDays !== WIDGET_SUPPORT_DAYS
  )
    return "Unknown widget manifest version.";
  if (!manifest.versions.some((version) => version.id === manifest.latest))
    return "The manifest names no latest build.";
  const ids = new Set();
  for (const version of manifest.versions) {
    if (ids.has(version.id)) return `${version.id} is listed twice.`;
    ids.add(version.id);
    if (
      !/^[0-9a-f]{64}$/.test(version.sha256) ||
      version.id !== version.sha256.slice(0, 16) ||
      version.path !== `/support-widget/${version.id}.js` ||
      files.get(`${version.id}.js`) !== version.sha256 ||
      Object.entries(version.chunks ?? {}).some(
        ([name, chunk]) =>
          !/^[0-9a-f]{64}$/.test(chunk.sha256) ||
          chunk.path !==
            `/support-widget/${name}-${chunk.sha256.slice(0, 16)}.js` ||
          files.get(`${name}-${chunk.sha256.slice(0, 16)}.js`) !== chunk.sha256,
      )
    )
      return `${version.path} is missing or changed.`;
    const latest = version.id === manifest.latest;
    if (
      latest &&
      Object.keys(version.chunks ?? {}).join() !== WIDGET_CHUNKS.join()
    )
      return `The latest build must load ${WIDGET_CHUNKS.join(", ")}.`;
    if (version.publishedAt === null && !latest)
      return `${version.id} was never shipped, so a newer build replaces it.`;
    if (latest) {
      if (version.supersededAt !== null || version.supportedUntil !== null)
        return "The latest build has no end date.";
    } else if (
      !/^\d{4}-\d{2}-\d{2}$/.test(version.supersededAt ?? "") ||
      version.supportedUntil !==
        addDays(version.supersededAt, WIDGET_SUPPORT_DAYS)
    )
      return `${version.id} must keep working ${WIDGET_SUPPORT_DAYS} days after a newer build replaced it.`;
  }
  const listed = new Set(manifest.versions.flatMap(widgetFiles));
  const unlisted = [...files.keys()].filter((name) => !listed.has(name));
  if (unlisted.length) return `Unlisted widget files: ${unlisted.join(", ")}.`;
  return null;
}
