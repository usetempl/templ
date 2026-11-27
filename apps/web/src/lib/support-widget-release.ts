import manifest from "./support-widget-versions.json";

/** A file a build loads on first use: `card` (the context card),
 * `extras` (what the member sees after a send, from Received and the AI
 * agent typing to the Verify wallet card, and the
 * Sign in again card), and the wallet sign-in for the page's wallet family,
 * `evm` or `solana`. */
export type SupportWidgetChunk = {
  path: string;
  sha256: string;
  sha384: string;
  bytes: number;
  gzipBytes: number;
};
/** One immutable build of the public widget, served at `path`. `publishedAt`
 * is set when a release ships it; an unreleased build is replaced by the next
 * one. A replaced build keeps working until `supportedUntil` (UTC date). */
export type SupportWidgetVersion = {
  id: string;
  path: string;
  sha256: string;
  sha384: string;
  sourceSha256: string;
  bytes: number;
  gzipBytes: number;
  /** Every build lists `card` and `extras`; the others follow the chunk
   * list of the release that made it (widget-budget.mjs WIDGET_CHUNKS). */
  chunks: Record<"card" | "extras", SupportWidgetChunk> &
    Partial<
      Record<
        | "appearance"
        | "style"
        | "lead"
        | "context"
        | "details"
        | "appParser"
        | "diagnostics"
        | "snapshot"
        | "welcome"
        | "conversation"
        | "conversation-style"
        | "drawer"
        | "drawer-style"
        | "drawer-notices"
        | "drawer-wallet"
        | "conversations"
        | "guest"
        | "art"
        | "media"
        | "report"
        | "report-flags"
        | "member"
        | "evm"
        | "solana"
        | "turnstile"
        | "live"
        | "encrypted"
        | "domain"
        | "frame"
        | "framebridge"
        | "framehost",
        SupportWidgetChunk
      >
    >;
  publishedAt: string | null;
  supersededAt: string | null;
  supportedUntil: string | null;
};

const versions = manifest.versions as unknown as SupportWidgetVersion[];
/** Days a replaced build keeps working. */
export const SUPPORT_WIDGET_SUPPORT_DAYS: number = manifest.supportDays;
/** The newest build. `/support-widget.js` serves the same bytes. */
export const SUPPORT_WIDGET_LATEST = versions.find(
  (version) => version.id === manifest.latest,
)!;
/** The URL path snippets and Templ's own pages load. */
export const SUPPORT_WIDGET_LATEST_PATH = SUPPORT_WIDGET_LATEST.path;

/** Builds a protocol site may still load on `now`: the latest one and every
 * replaced one inside its support window. */
export function supportedWidgetVersions(
  now = Date.now(),
): SupportWidgetVersion[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return versions.filter(
    (version) =>
      version.supportedUntil === null || version.supportedUntil >= today,
  );
}
