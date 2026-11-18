import { AUTH_METHODS, type AuthMethod } from "./principal";

/** Onboarding counts kept by the worker. Every field of an event is one of the
 * fixed labels below: no account, wallet, workspace, message, email or URL. */
export const FUNNEL_POLICY = {
  retentionDays: 400,
  /** Events one request or one flush may send. */
  maxBatch: 16,
  /** The most one event may count; a worker adds up repeats before sending. */
  maxCount: 100_000,
  /** Sign-ins and refusals one worker instance adds up are sent at most this
   * often, so request volume never becomes one metrics write per request. */
  sendGapMs: 2_000,
  /** Report windows an operator can choose, in days. */
  windows: [7, 30, 90],
} as const;

/** Workspace steps count their first success. Site, sign-in and guest
 * follow-up actions count each success. Refused attempts count by cause. */
export const FUNNEL_STEPS = {
  prompt_copied: { label: "Copied the install prompt", scope: "site" },
  widget_prompt_used: { label: "Asked about Templ", scope: "site" },
  widget_lead_email: { label: "Shared a lead email", scope: "site" },
  widget_lead_wallet: { label: "Shared a lead wallet", scope: "site" },
  widget_lead_qualified: { label: "Sent app details", scope: "site" },
  connect_started: { label: "Started app connect", scope: "site" },
  connect_opened: { label: "Opened app connect", scope: "site" },
  connect_approved: { label: "Approved app connect", scope: "site" },
  connect_denied: { label: "Cancelled app connect", scope: "site" },
  signed_in: { label: "Signed in", scope: "sign-in" },
  workspace_created: { label: "Created a workspace", scope: "workspace" },
  team_invite_created: { label: "Created a team invitation", scope: "workspace" },
  team_invite_accepted: { label: "Teammate joined", scope: "workspace" },
  widget_site_approved: { label: "Approved a website", scope: "workspace" },
  /** The first widget request from an approved website. */
  widget_seen: { label: "Install detected", scope: "workspace" },
  guest_email_changed: { label: "Changed guest reply emails", scope: "site" },
  guest_email_confirmed: {
    label: "Confirmed guest reply emails",
    scope: "site",
  },
  guest_link_resumed: { label: "Opened a guest reply link", scope: "site" },
  first_request: { label: "First user case", scope: "workspace" },
  first_reply: { label: "First team reply", scope: "workspace" },
  first_resolution: { label: "First resolved case", scope: "workspace" },
  free_start_used: { label: "Free resolved cases used", scope: "workspace" },
  balance_empty: { label: "Balance ran out", scope: "workspace" },
  grant_credited: { label: "First grant credited", scope: "workspace" },
  card_setup_confirmed: { label: "Saved a card", scope: "workspace" },
  card_invoice_paid: { label: "Paid the first card invoice", scope: "workspace" },
  checkout_started: { label: "Started a checkout", scope: "workspace" },
  payment_credited: {
    label: "First top-up credited",
    scope: "workspace",
  },
} as const;
export type FunnelStep = keyof typeof FUNNEL_STEPS;
export type WorkspaceFunnelStep = Exclude<
  FunnelStep,
  | "connect_started"
  | "connect_opened"
  | "connect_approved"
  | "connect_denied"
  | "signed_in"
  | "prompt_copied"
  | "widget_prompt_used"
  | "widget_lead_email"
  | "widget_lead_wallet"
  | "widget_lead_qualified"
  | "guest_email_changed"
  | "guest_email_confirmed"
  | "guest_link_resumed"
>;
/** Site counts use fixed, bodiless paths and carry no visitor details. */
export const SITE_FUNNEL_PATHS = {
  prompt_copied: "/funnel/prompt-copied",
  widget_prompt_used: "/funnel/widget-prompt-used",
  widget_lead_email: "/funnel/widget-lead-email",
  widget_lead_wallet: "/funnel/widget-lead-wallet",
  widget_lead_qualified: "/funnel/widget-lead-qualified",
} as const;
export type FunnelScope = (typeof FUNNEL_STEPS)[FunnelStep]["scope"];

export type FunnelSignInMethod = Exclude<AuthMethod, "guest">;
export const FUNNEL_SIGN_IN_METHODS = AUTH_METHODS.filter(
  (method): method is FunnelSignInMethod => method !== "guest",
);

/** Why an attempt failed: a reason code the route already returns, or else
 * the class of its HTTP status. */
export const FUNNEL_CAUSES = {
  "invalid-request": "Invalid request",
  unauthorized: "Proof or session refused",
  forbidden: "Not allowed",
  "not-found": "Not found",
  conflict: "Conflict",
  "rate-limited": "Rate limited",
  unavailable: "Service unavailable",
  other: "Other refusal",
  "origin-not-approved": "Website not approved",
  "strong-auth-required": "Fresh sign-in required",
  "product-checkout-unavailable": "Checkout closed",
  "card-billing-unavailable": "Card billing closed",
  "stripe-unavailable": "Stripe unavailable",
  "support-paused": "Paused until a top-up",
  "support-suspended": "Suspended by Templ",
  "access-level-required": "Widget asks for a wallet",
  quota: "Too many new cases",
  cap: "Open case limit",
  "provider-capacity": "Stored case limit",
  "support-message-capacity": "Message limit",
  "support-storage-busy": "Storage catching up",
} as const;
export type FunnelCause = keyof typeof FUNNEL_CAUSES;
const own = (object: object, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key);
/** Reviewed reason codes the routes return, and the cause each counts as. */
const REASONS: Readonly<Record<string, FunnelCause>> = {
  "origin-not-approved": "origin-not-approved",
  "strong-auth-required": "strong-auth-required",
  "product-checkout-unavailable": "product-checkout-unavailable",
  "support-paused": "support-paused",
  "support-suspended": "support-suspended",
  "access-level-required": "access-level-required",
  quota: "quota",
  cap: "cap",
  "provider-capacity": "provider-capacity",
  "support-message-capacity": "support-message-capacity",
  "support-storage-busy": "support-storage-busy",
};

/** The cause for a refused response; `reason` counts only when reviewed. */
export function funnelCause(status: number, reason?: unknown): FunnelCause {
  if (typeof reason === "string" && own(REASONS, reason))
    return REASONS[reason];
  if (status === 400 || status === 413 || status === 422)
    return "invalid-request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  return "other";
}

export type FunnelEvent = {
  step: FunnelStep;
  outcome: "done" | "failed";
  /** Failed attempts only. */
  cause?: FunnelCause;
  /** Sign-ins only. */
  method?: FunnelSignInMethod;
  /** How many times it happened; 1 when absent. */
  count?: number;
};

/** Accepts exactly one well-formed event and nothing else. */
export function funnelEvent(value: unknown): FunnelEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const event = value as Record<string, unknown>;
  const keys = Object.keys(event);
  if (
    typeof event.step !== "string" ||
    !own(FUNNEL_STEPS, event.step) ||
    (event.outcome !== "done" && event.outcome !== "failed") ||
    keys.some(
      (key) => !["step", "outcome", "cause", "method", "count"].includes(key),
    ) ||
    ("count" in event &&
      (!Number.isSafeInteger(event.count) ||
        (event.count as number) < 1 ||
        (event.count as number) > FUNNEL_POLICY.maxCount))
  )
    return;
  const step = event.step as FunnelStep;
  if (event.outcome === "failed") {
    if (typeof event.cause !== "string" || !own(FUNNEL_CAUSES, event.cause))
      return;
  } else if ("cause" in event) return;
  if ("method" in event) {
    if (
      step !== "signed_in" ||
      !FUNNEL_SIGN_IN_METHODS.includes(event.method as FunnelSignInMethod)
    )
      return;
  } else if (step === "signed_in") return;
  return {
    step,
    outcome: event.outcome as FunnelEvent["outcome"],
    ...(event.outcome === "failed"
      ? { cause: event.cause as FunnelCause }
      : {}),
    ...(step === "signed_in"
      ? { method: event.method as FunnelSignInMethod }
      : {}),
    ...("count" in event ? { count: event.count as number } : {}),
  };
}

/** One UTC day of counts. */
export type FunnelDay = {
  day: string;
  done: Partial<Record<FunnelStep, number>>;
  failed: Partial<Record<FunnelStep, Partial<Record<FunnelCause, number>>>>;
  signIns: Partial<Record<FunnelSignInMethod, number>>;
};
export const funnelDayOf = (nowMs: number) =>
  new Date(nowMs).toISOString().slice(0, 10);
export function emptyFunnelDay(day: string): FunnelDay {
  return { day, done: {}, failed: {}, signIns: {} };
}
export function addFunnelEvent(day: FunnelDay, event: FunnelEvent) {
  const count = event.count ?? 1;
  if (event.outcome === "done") {
    day.done[event.step] = (day.done[event.step] ?? 0) + count;
    if (event.method)
      day.signIns[event.method] = (day.signIns[event.method] ?? 0) + count;
    return;
  }
  const causes = (day.failed[event.step] ??= {});
  causes[event.cause!] = (causes[event.cause!] ?? 0) + count;
}

export type FunnelReport = {
  from: string;
  to: string;
  /** False when the counts could not be read; the totals are then empty. */
  available: boolean;
  steps: {
    step: FunnelStep;
    label: string;
    scope: FunnelScope;
    done: number;
    failed: { cause: FunnelCause; label: string; count: number }[];
  }[];
  signIns: { method: FunnelSignInMethod; count: number }[];
  days: FunnelDay[];
};
/** Totals for the chosen days, steps in funnel order. */
export function funnelReport(input: {
  from: string;
  to: string;
  available: boolean;
  days: FunnelDay[];
}): FunnelReport {
  const days = [...input.days].sort((a, b) => a.day.localeCompare(b.day));
  const sum = (read: (day: FunnelDay) => number | undefined) =>
    days.reduce((total, day) => total + (read(day) ?? 0), 0);
  return {
    from: input.from,
    to: input.to,
    available: input.available,
    steps: (Object.keys(FUNNEL_STEPS) as FunnelStep[]).map((step) => ({
      step,
      label: FUNNEL_STEPS[step].label,
      scope: FUNNEL_STEPS[step].scope,
      done: sum((day) => day.done[step]),
      failed: (Object.keys(FUNNEL_CAUSES) as FunnelCause[])
        .map((cause) => ({
          cause,
          label: FUNNEL_CAUSES[cause],
          count: sum((day) => day.failed[step]?.[cause]),
        }))
        .filter((entry) => entry.count > 0),
    })),
    signIns: FUNNEL_SIGN_IN_METHODS.map((method) => ({
      method,
      count: sum((day) => day.signIns[method]),
    })).filter((entry) => entry.count > 0),
    days,
  };
}
