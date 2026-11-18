/** The Add screenshot button, from the member lines: while
 * the workspace's policy says members may add screenshots and the member
 * has a thread, the `media` chunk draws the button in the tools row and
 * handles the file. */
import type { TailHost } from "./support-widget";

/* The media chunk (support-widget-media.ts). */
declare const __TEMPL_WIDGET_MEDIA__: string | undefined;
const loadMedia = (): Promise<typeof import("./support-widget-media")> =>
  typeof __TEMPL_WIDGET_MEDIA__ == "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        new globalThis.URL(__TEMPL_WIDGET_MEDIA__, import.meta.url).href
      )
    : import("./support-widget-media");

export function screenshotButton(host: TailHost, thread: string) {
  if (host.policy?.screenshots)
    loadMedia().then(
      (module) => module.button(host, thread),
      () => {},
    );
}
