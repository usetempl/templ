import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
/** Frame mode, the worker's side. A protocol page may
 * run the widget in a frame served from Templ's frame origin, apart from
 * the page's own scripts. Requests from that frame carry the frame origin
 * in `Origin` (the browser sets it) and name the page they sit in with
 * `X-Templ-Host-Origin` (or `?host=` on the socket upgrade, which can't
 * carry a header). The worker validates the host origin and scopes every
 * record the frame makes to
 * `{ room, origin: host, frame: true }`, so nothing made in the frame works
 * outside it and nothing made on the page works in it.
 *
 * Off while `SUPPORT_WIDGET_FRAME_ORIGIN` is empty. A manager can then also
 * require frame mode for a workspace; inline requests are refused, and a
 * workspace that requires it while Templ has frame mode off is refused
 * whole (fail closed). Sign-out and forgetting a remembered sign-in stay
 * open in every case, so old sessions can always end. */
import {
  isFrameHostOrigin,
  WIDGET_HOST_ORIGIN_HEADER,
} from "@templ/chat/widget-frame";
import { HttpError } from "./common";

export type WidgetFrameEnv = WorkspaceFlagEnv & {
  /** Templ's frame origin, such as https://frame.templ.vip; empty is off. */
  SUPPORT_WIDGET_FRAME_ORIGIN?: string;
  APP_ORIGIN?: string;
  SUPPORT_HOSTED_PAGE_ENABLED?: string;
};
/** A widget scope: the workspace, the website and, for a frame, the flag. */
export type FrameAwareScope = { room: string; origin: string; frame?: true };

/** The configured frame origin, or null when frame mode is off or the value
 * is not an HTTPS origin distinct from the app. */
export function widgetFrameOrigin(env: WidgetFrameEnv): string | null {
  if (!featureOn(env, undefined, "frameMode")) return null;
  return configuredFrameOrigin(env);
}
function configuredFrameOrigin(env: WidgetFrameEnv): string | null {
  if (env.SUPPORT_WIDGET_FRAME_ENABLED !== "true") return null;
  const value = env.SUPPORT_WIDGET_FRAME_ORIGIN;
  return isFrameHostOrigin(value) && value !== env.APP_ORIGIN ? value : null;
}

const refused = () =>
  new HttpError(
    400,
    "This website can't use the support widget this way.",
    undefined,
    "host-origin-refused",
  );

/** The website a widget request speaks for. From the frame origin it is the
 * host origin the frame names; from anywhere else it is `Origin`, and a
 * host origin named there is refused rather than ignored. */
export function widgetRequestOrigin(
  request: Request,
  env: WidgetFrameEnv,
  url: URL,
): { origin: string; frame: boolean; frameOrigin: string | null } {
  const requestOrigin = request.headers.get("Origin") ?? "";
  const hostHeader = request.headers.get(WIDGET_HOST_ORIGIN_HEADER);
  const frameOrigin = configuredFrameOrigin(env);
  const frame = frameOrigin !== null && requestOrigin === frameOrigin;
  if (!frame) {
    if (hostHeader !== null || url.searchParams.has("host")) throw refused();
    return { origin: requestOrigin, frame: false, frameOrigin };
  }
  // A preflight carries header names, not values: it names no host.
  if (request.method === "OPTIONS")
    return { origin: "", frame: true, frameOrigin };
  // The member socket's upgrade, not the ticket route before it.
  const socket = /^\/widget\/[^/]+\/live$/.test(url.pathname);
  const hosts = socket ? url.searchParams.getAll("host") : [hostHeader];
  const host = hosts.length === 1 ? hosts[0] : null;
  if (
    !isFrameHostOrigin(host) ||
    host === frameOrigin ||
    (host === env.APP_ORIGIN && env.SUPPORT_HOSTED_PAGE_ENABLED !== "true") ||
    (!socket && url.searchParams.has("host"))
  )
    throw refused();
  return { origin: host, frame: true, frameOrigin };
}

/** The scope a request's records carry. */
export const widgetScopeFor = (
  room: string,
  origin: string,
  frame: boolean,
): FrameAwareScope =>
  frame ? { room, origin, frame: true } : { room, origin };

/** Same workspace, same website and the same side of the frame. */
export function sameWidgetScope(
  stored: Partial<FrameAwareScope> | null | undefined,
  scope: Partial<FrameAwareScope> | null | undefined,
): boolean {
  return (
    !!stored &&
    !!scope &&
    typeof stored.room === "string" &&
    typeof stored.origin === "string" &&
    stored.room === scope.room &&
    stored.origin === scope.origin &&
    (stored.frame === true) === (scope.frame === true)
  );
}

/** Routes that end a session or a remembered sign-in: open whatever the
 * workspace's frame setting says. */
const ENDING = new Set(["/auth/logout", "/auth/forget"]);

/** The workspace's frame requirement applied after website validation:
 * null to go on, or the refusal. */
export function frameRequirement(input: {
  frameRequired: boolean;
  frame: boolean;
  frameOrigin: string | null;
  path: string;
  method: string;
}): HttpError | null {
  if (!input.frameRequired || input.method === "OPTIONS") return null;
  if (ENDING.has(input.path)) return null;
  if (input.frameOrigin === null)
    return new HttpError(
      403,
      "Support is unavailable. Try again.",
      undefined,
      "frame-unavailable",
    );
  if (!input.frame)
    return new HttpError(
      403,
      "This chat can't open on this page. The team needs to update it.",
      undefined,
      "frame-required",
    );
  return null;
}

/** A manager's `frameRequired` field: a boolean. Turning it on needs frame
 * mode on at Templ; turning it off always works. */
export function widgetFrameRequired(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new HttpError(400, "Choose whether the chat needs frame mode.");
  return value;
}
export const frameUnavailable = () =>
  new HttpError(
    409,
    "Frame mode isn't available yet.",
    undefined,
    "frame-unavailable",
  );

/** The socket address a frame's ticket names: the worker's own host and
 * the workspace, with the host origin the upgrade will be checked against. */
export const frameSocketUrl = (apiHost: string, room: string, host: string) =>
  `wss://${apiHost}/widget/${room}/live?host=${encodeURIComponent(host)}`;
