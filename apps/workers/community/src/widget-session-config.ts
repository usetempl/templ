import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
/** Templ's own switches for the widget sign-in features, read from worker
 * vars and secrets. Each one is off unless its var says "true" and what it
 * needs is configured; a missing secret never turns a feature on. A
 * workspace setting can only narrow what these allow. */
import { hostedPageOffered } from "./hosted-support";
import { HttpError, json } from "./common";
import { widgetFrameOrigin, type WidgetFrameEnv } from "./widget-frame";
import { widgetIntroFields } from "./widget-intro";
import {
  checkedWidgetAppearance,
  type WidgetAppearance,
} from "@templ/chat/widget-appearance";

export type WidgetSessionEnv = WidgetFrameEnv &
  WorkspaceFlagEnv & {
    /** Remembered widget sign-in. */
    SUPPORT_WIDGET_REMEMBER?: string;
    /** 32 random bytes as 64 lowercase hex, created by the secrets writer
     * when the var turns on. Rotating it ends every remembered sign-in. */
    WIDGET_REMEMBER_KEY?: string;
    /** Member sockets for the widget. */
    SUPPORT_WIDGET_REALTIME?: string;
    /** http development origins on this computer. */
    SUPPORT_WIDGET_LOOPBACK?: string;
    /** ERC-1271 and ERC-6492 widget sign-in on Ethereum and Katana. */
    SUPPORT_WIDGET_SMART_WALLETS?: string;
    /** The visitor check on guest creation. */
    GUEST_TURNSTILE_ENABLED?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
  };

const on = (value: unknown) => value === "true";
const HEX_KEY = /^[0-9a-f]{64}$/;
/** Cloudflare site keys are public; a secret is never read here. */
const SITE_KEY = /^[0-9A-Za-z_-]{10,64}$/;

export const rememberOffered = (env: WidgetSessionEnv) =>
  featureOn(env, undefined, "rememberSignIn") &&
  typeof env.WIDGET_REMEMBER_KEY === "string" &&
  HEX_KEY.test(env.WIDGET_REMEMBER_KEY);
export const realtimeOffered = (env: WidgetSessionEnv) =>
  on(env.SUPPORT_WIDGET_REALTIME);
export const loopbackOffered = (env: WidgetSessionEnv) =>
  featureOn(env, undefined, "loopbackOrigins");
export const smartWalletsOffered = (env: WidgetSessionEnv) =>
  featureOn(env, undefined, "smartWalletSignIn");
/** The switch is on and both keys are present. */
export const guestCheckOffered = (env: WidgetSessionEnv) =>
  featureOn(env, undefined, "guestCheck") &&
  typeof env.TURNSTILE_SITE_KEY === "string" &&
  SITE_KEY.test(env.TURNSTILE_SITE_KEY) &&
  typeof env.TURNSTILE_SECRET_KEY === "string" &&
  env.TURNSTILE_SECRET_KEY.length > 0;

/** The manager's save fields this lane owns, checked for shape, with what
 * the worker knows about Templ's switches. The settings object decides the
 * rest (epoch bumps, the audit entries, a refused check). */
export function widgetSessionSettings(
  body: Record<string, unknown>,
  env: WidgetSessionEnv,
) {
  let appearance: WidgetAppearance | null | undefined;
  if (body.appearance !== undefined) {
    try {
      appearance = checkedWidgetAppearance(body.appearance);
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "Check the widget settings.",
      );
    }
  }
  for (const key of ["walletFallback", "askPerson", "hostedPage"])
    if (body[key] !== undefined && typeof body[key] !== "boolean")
      throw new HttpError(400, "Choose on or off.");
  if (body.remember !== undefined && typeof body.remember !== "boolean")
    throw new HttpError(400, "Choose whether users stay signed in.");
  if (body.endSessions !== undefined && body.endSessions !== true)
    throw new HttpError(400, "Invalid widget settings.");
  if (
    body.guestCheck !== undefined &&
    body.guestCheck !== "off" &&
    body.guestCheck !== "turnstile"
  )
    throw new HttpError(400, "Choose whether to check visitors.");
  if (body.safetyLine !== undefined && typeof body.safetyLine !== "boolean")
    throw new HttpError(
      400,
      "Choose whether the widget shows the safety line.",
    );
  if (
    body.frameRequired !== undefined &&
    typeof body.frameRequired !== "boolean"
  )
    throw new HttpError(400, "Choose whether the chat needs frame mode.");
  return {
    ...(body.appearance === undefined
      ? {}
      : { appearance, appearanceRevision: body.appearanceRevision }),
    ...widgetIntroFields(body, featureOn(env, undefined, "widgetIntro")),
    ...(body.hostedPage === undefined ? {} : { hostedPage: body.hostedPage }),
    hostedPageAvailable: hostedPageOffered(env),
    ...(body.walletFallback === undefined
      ? {}
      : { walletFallback: body.walletFallback }),
    ...(body.askPerson === undefined ? {} : { askPerson: body.askPerson }),
    ...(body.remember === undefined ? {} : { remember: body.remember }),
    ...(body.endSessions === true ? { endSessions: true } : {}),
    ...(body.guestCheck === undefined ? {} : { guestCheck: body.guestCheck }),
    // The manager's "We never DM you first." line.
    ...(body.safetyLine === undefined ? {} : { safetyLine: body.safetyLine }),
    // Frame mode required, with Templ's frame switch.
    ...(body.frameRequired === undefined
      ? {}
      : { frameRequired: body.frameRequired }),
    frameAvailable: widgetFrameOrigin(env) !== null,
    loopback: loopbackOffered(env),
    guestCheckAvailable: guestCheckOffered(env),
  };
}
/** Whether a manager's save names any field this lane owns. */
export const namesWidgetSessionSetting = (body: Record<string, unknown>) =>
  body.appearance !== undefined ||
  body.hostedPage !== undefined ||
  body.walletFallback !== undefined ||
  body.askPerson !== undefined ||
  body.remember !== undefined ||
  body.endSessions !== undefined ||
  body.guestCheck !== undefined ||
  body.safetyLine !== undefined ||
  body.prompts !== undefined ||
  body.replyHours !== undefined ||
  body.frameRequired !== undefined;
/** What the manager's settings page may offer: each feature Templ has on. */
export const widgetSessionOptions = (env: WidgetSessionEnv) => ({
  appearance: true,
  ...(featureOn(env, undefined, "widgetIntro") ? { widgetIntro: true } : {}),
  ...(hostedPageOffered(env) ? { hostedPage: true } : {}),
  remember: rememberOffered(env),
  loopback: loopbackOffered(env),
  guestCheck: guestCheckOffered(env),
  // Only while Templ's frame origin is set.
  ...(widgetFrameOrigin(env) !== null ? { frame: true } : {}),
});
/** The manager's settings answer with the options Templ offers now. */
export async function withWidgetSessionOptions(
  env: WidgetSessionEnv,
  response: Response,
) {
  if (!response.ok) return response;
  const options = widgetSessionOptions(env);
  // Empty options keep the settings response small.
  const body = await response.json<Record<string, unknown>>();
  delete body.workspaceFlags;
  return json(
    { ...body, ...(Object.values(options).some(Boolean) ? { options } : {}) },
    response.status,
  );
}
