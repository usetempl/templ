import { SITE_FUNNEL_PATHS } from "@templ/chat/funnel";
import { trackEvent } from "./analytics";
import { SITE } from "./site-environment";

const EVENTS = {
  prompt_used: "widget_prompt_used",
  lead_email: "widget_lead_email",
  lead_wallet: "widget_lead_wallet",
  lead_qualified: "widget_lead_qualified",
} as const;
export type TemplWidgetStep = keyof typeof EVENTS;

/** Templ's page records fixed actions. Customer widgets load no analytics. */
export function trackTemplWidgetStep(
  step: TemplWidgetStep,
  send: typeof fetch = fetch,
) {
  if (!Object.hasOwn(EVENTS, step)) return;
  const event = EVENTS[step];
  trackEvent(event);
  try {
    if (location.origin !== SITE.origin) return;
    void send(`${SITE.community}${SITE_FUNNEL_PATHS[event]}`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      keepalive: true,
      referrerPolicy: "no-referrer",
    }).catch(() => {});
  } catch {
    /* Measurement cannot change the accepted action. */
  }
}
