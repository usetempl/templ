import type { createSupportClient, mountSupportWidget } from "./support-widget";
import {
  SUPPORT_WIDGET_LATEST,
  SUPPORT_WIDGET_LATEST_PATH,
} from "./support-widget-release";

type SupportRelease = {
  supportWidgetVerified: boolean;
  conversationsVerified: boolean;
  supportWorkflowVerified: boolean;
  templSupport?: {
    verified: boolean;
    workspaceId: string | null;
    expiresAt: string | null;
  };
};

export function templSupportWorkspace(
  release: SupportRelease,
  origin: string,
  siteOrigin: string,
  now = Date.now(),
): string | null {
  const support = release.templSupport;
  if (
    !release.supportWidgetVerified ||
    !release.conversationsVerified ||
    !release.supportWorkflowVerified ||
    !support?.verified ||
    !support.workspaceId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      support.workspaceId,
    ) ||
    (support.expiresAt !== null &&
      (typeof support.expiresAt !== "string" ||
        !(Date.parse(support.expiresAt) > now))) ||
    origin !== siteOrigin ||
    !origin.startsWith("https://")
  )
    return null;
  return support.workspaceId;
}

/** Null expiry uses the reviewed operator grant. The worker checks coverage on every request. */
export function templSupportRecheckDelay(
  expiresAt: string | null,
  now = Date.now(),
) {
  if (expiresAt === null) return 60_000;
  const remaining = Date.parse(expiresAt) - now;
  return Number.isFinite(remaining)
    ? Math.min(60_000, Math.max(1, remaining))
    : 1;
}

type WidgetModule = {
  mountSupportWidget: typeof mountSupportWidget;
  createSupportClient?: typeof createSupportClient;
};

/** Cache a successful public-module import and retry imports that fail. */
export function createTemplSupportWidgetLoader(
  importModule: () => Promise<unknown>,
) {
  let widgetModule: Promise<WidgetModule> | undefined;
  return () => {
    if (!widgetModule) {
      widgetModule = importModule()
        .then((module) => {
          if (
            !module ||
            typeof module !== "object" ||
            !("mountSupportWidget" in module) ||
            typeof module.mountSupportWidget !== "function"
          )
            throw new Error("Support could not load.");
          return module as WidgetModule;
        })
        .catch((error: unknown) => {
          widgetModule = undefined;
          throw error;
        });
    }
    return widgetModule;
  };
}

/** Load the same public module installed by protocol teams, on first use. */
export const loadTemplSupportWidget = createTemplSupportWidgetLoader(() => {
  // Resolve in the browser so the server packager does not treat this public
  // module as a file-system dependency.
  const asset = new URL(SUPPORT_WIDGET_LATEST_PATH, window.location.origin)
    .href;
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ asset);
});

/** Templ's checked support workspace may show the optional stamp art. */
export function loadTemplSupportArt(): Promise<
  typeof import("./support-widget-art")
> {
  const asset = new URL(
    SUPPORT_WIDGET_LATEST.chunks.art!.path,
    window.location.origin,
  ).href;
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ asset);
}
